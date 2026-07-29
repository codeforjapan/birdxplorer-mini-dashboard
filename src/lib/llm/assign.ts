import { z } from "zod";
import { activeClusters } from "../clusters";
import type { Cluster } from "../types";
import { chatJson, chunk } from "./client";
import type { AssignInput, ClusterAssignment, LlmBatchResult } from "./contract";

/**
 * Stage 2 — クラスタ割当（docs/spec.md §4 Stage 2）。
 *
 * 既存クラスタへの再利用を強く優先させ、新規クラスタは「本当に別種の噂」のときだけ
 * 提案させる。そうしないとクラスタ数が際限なく増え、フロントの凡例・パレット（10色）が
 * すぐに破綻する。
 *
 * **モデルにIDを発明させない**: クラスタIDの永続性はタイムライン配色の一貫性の前提
 * （src/lib/clusters.ts 参照）。新規クラスタのID採番・colorIndex割当は呼び出し側が行う
 * （contract.ts のコメントどおり）。ここでは「既存クラスタに割り当てる」と言ってきた
 * clusterId が、渡した一覧に実在し、かつ吸収済み（aliasOf 済み）でないことを必ず検証する。
 * 存在しないIDを返してきたノートは failedNoteIds へ回す。
 */

const CHUNK_SIZE = 20;

const ASSIGN_SYSTEM_PROMPT = `あなたはXコミュニティノートを「噂の種類（クラスタ）」に分類するアシスタントです。

対象はすべて「2026年7月28日の熊本地震」に関連すると判定済みのノートです。
クラスタは固定のタクソノミーではなく、これまでに見つかった「噂・誤情報の型」の一覧です。

分類方針（最重要）:
- まず既存クラスタの説明を読み、意味的に合致するものがあれば必ずそれに割り当ててください（kind: "existing"）。
- 新規クラスタ（kind: "new"）を提案してよいのは、既存のどのクラスタとも噂の内容が明確に異なる場合だけです。
  「表現が違うだけで言っている内容は同じ噂」は既存クラスタに寄せてください。新規提案を安易に増やさないでください。
- クラスタ名（name）は日本語で短く、「何のトピックか」ではなく「どんな噂・誤情報か」を表すものにしてください。
  良い例: 「支援物資デマ」「なりすまし公式アカウント」「津波過大予測の誤情報」
  悪い例: 「地震について」「熊本関連」のようなトピック名そのもの
- description は1-2文で、その噂が具体的にどういう内容かを説明してください。

既存クラスタが1件もない場合のみ、最初のノートから新規クラスタを起こして構いません。
入力された note_id は1件も欠かさず、必ずすべてに対して結果を1件ずつ返してください。`;

const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          note_id: { type: "string" },
          kind: { type: "string", enum: ["existing", "new"] },
          // strict モードでは全プロパティが required 必須なため、使わない側は null を返させる。
          cluster_id: { type: ["string", "null"] },
          name: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
        },
        required: ["note_id", "kind", "cluster_id", "name", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

const EnvelopeSchema = z.object({
  results: z.array(z.unknown()),
});

const ItemSchema = z.object({
  note_id: z.string().min(1),
  kind: z.enum(["existing", "new"]),
  cluster_id: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
});

/** ワイヤー形式（フラットな nullable 構造）を contract.ts の判別ユニオンに変換する。形が矛盾していれば null。 */
function toAssignment(raw: z.infer<typeof ItemSchema>): ClusterAssignment | null {
  if (raw.kind === "existing") {
    if (!raw.cluster_id) return null;
    return { noteId: raw.note_id, kind: "existing", clusterId: raw.cluster_id };
  }
  if (!raw.name?.trim() || !raw.description?.trim()) return null;
  return { noteId: raw.note_id, kind: "new", name: raw.name, description: raw.description };
}

async function assignChunk(
  validClusterIds: ReadonlySet<string>,
  clusterPayload: { id: string; name: string; description: string }[],
  inputs: AssignInput[],
): Promise<LlmBatchResult<ClusterAssignment>> {
  const requestedIds = new Set(inputs.map((n) => n.noteId));

  const outcome = await chatJson({
    stage: "assign",
    systemPrompt: ASSIGN_SYSTEM_PROMPT,
    userPayload: {
      existing_clusters: clusterPayload,
      notes: inputs.map((n) => ({ note_id: n.noteId, summary: n.summary })),
    },
    jsonSchema: RESPONSE_JSON_SCHEMA,
    schemaName: "assign_batch",
    zodSchema: EnvelopeSchema,
    temperature: 0,
  });

  if (!outcome.ok) {
    return { results: [], failedNoteIds: [...requestedIds] };
  }

  const byNoteId = new Map<string, ClusterAssignment>();
  for (const raw of outcome.data.results) {
    const parsedItem = ItemSchema.safeParse(raw);
    if (!parsedItem.success) continue;
    if (!requestedIds.has(parsedItem.data.note_id)) continue;

    let assignment = toAssignment(parsedItem.data);
    if (!assignment) continue;
    // モデルにIDを発明させない: 既存クラスタとして返してきたIDが、渡した一覧に実在し
    // かつ吸収済み（aliasOf済み）でないことを検証する。
    if (assignment.kind === "existing" && !validClusterIds.has(assignment.clusterId)) {
      // 実測した挙動: モデルは「本当は新規クラスタの噂」を kind:"existing" のまま
      // 存在しない cluster_id（渡した一覧の続き番号を勝手に想像したもの）で返してくることがある。
      // その場合でも name/description には具体的な新規クラスタ相当の内容が入っているため、
      // 発明されたIDだけを捨てて kind:"new" として救済する（IDは createCluster が採番し直すので
      // 「モデルにIDを発明させない」制約は破らない）。name/description が無ければ従来どおり失敗扱い。
      const parsedRaw = parsedItem.data;
      if (parsedRaw.name?.trim() && parsedRaw.description?.trim()) {
        assignment = { noteId: parsedRaw.note_id, kind: "new", name: parsedRaw.name, description: parsedRaw.description };
      } else {
        continue;
      }
    }

    byNoteId.set(assignment.noteId, assignment);
  }

  const results: ClusterAssignment[] = [];
  const failedNoteIds: string[] = [];
  for (const noteId of requestedIds) {
    const hit = byNoteId.get(noteId);
    if (hit) results.push(hit);
    else failedNoteIds.push(noteId);
  }
  return { results, failedNoteIds };
}

export async function assignClusters(
  clusters: Cluster[],
  inputs: AssignInput[],
): Promise<LlmBatchResult<ClusterAssignment>> {
  if (inputs.length === 0) return { results: [], failedNoteIds: [] };

  // 吸収済み（aliasOf が非null）のクラスタは割当対象から除外する。モデルにも見せない。
  const active = activeClusters(clusters);
  const validClusterIds = new Set(active.map((c) => c.id));
  const clusterPayload = active.map((c) => ({ id: c.id, name: c.name, description: c.description }));

  const results: ClusterAssignment[] = [];
  const failedNoteIds: string[] = [];
  for (const part of chunk(inputs, CHUNK_SIZE)) {
    const chunkResult = await assignChunk(validClusterIds, clusterPayload, part);
    results.push(...chunkResult.results);
    failedNoteIds.push(...chunkResult.failedNoteIds);
  }
  return { results, failedNoteIds };
}
