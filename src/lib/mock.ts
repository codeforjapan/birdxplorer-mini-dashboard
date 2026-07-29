import { BIN_MINUTES, MAINSHOCK_AT } from "./constants";
import { binStart, nextBin } from "./time";
import type { Cluster, ClustersFile, Note, NotesFile, TimelineBin, TimelineFile } from "./types";

/**
 * 実データが無い段階でもUIをレビューできるようにするための、もっともらしい疑似データ生成器。
 *
 * 本番Blobには絶対に混ざってはいけないため、有効化条件は呼び出し側(page.tsx)で
 * `?mock=1` かつ `NODE_ENV !== "production"` の両方を必須にする。`shouldUseMock` に
 * その判定をまとめておき、ページ側で条件を書き間違えて本番で有効化する事故を防ぐ。
 */
export function shouldUseMock(searchParamValue: string | string[] | undefined): boolean {
  const value = Array.isArray(searchParamValue) ? searchParamValue[0] : searchParamValue;
  return value === "1" && process.env.NODE_ENV !== "production";
}

/** 決定的な疑似乱数(mulberry32)。毎回同じ形のデータを出すことでレビュー時の比較を安定させる。 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type ClusterSeed = {
  name: string;
  description: string;
  /** 生成する疑似ノートのおおよその相対的な量(重み)。 */
  weight: number;
  templates: string[];
};

// 熊本地震まわりで実際に流通しがちな誤情報カテゴリを模した疑似クラスタ。
// 13件用意し、上位8 + 「その他」への集約(§3)がモックの時点で正しく機能するようにする。
const CLUSTER_SEEDS: ClusterSeed[] = [
  {
    name: "断水・給水情報の誤り",
    weight: 22,
    description: "特定地域の断水復旧時期や給水拠点の場所について、古い情報や未確認情報が広まっている。",
    templates: [
      "○○地区の断水は来週まで続くと聞きました。給水車も来ないそうです。",
      "△△小学校の給水は終了したというデマが広がっているが、実際は継続中。",
      "水道局が全面復旧を発表したとの情報があるが、公式発表は確認できず。",
    ],
  },
  {
    name: "避難所の受け入れ状況の誤り",
    weight: 18,
    description: "避難所が満員で受け入れ不可という情報が、実際の空き状況と食い違って拡散している。",
    templates: [
      "○○体育館は満員で入れないと投稿されているが、市の発表では空きあり。",
      "ペット同伴不可の避難所が同伴可能と誤って紹介されている。",
      "避難所が閉鎖されたという未確認の投稿が拡散中。",
    ],
  },
  {
    name: "動物園・施設からの動物脱走デマ",
    weight: 14,
    description: "地震で猛獣が檻から脱走したという、過去の熊本地震(2016年)由来の古いデマの再流通。",
    templates: [
      "動物園からライオンが逃げ出したという投稿が出回っているが、園は否定を発表。",
      "2016年の投稿が地震発生日と誤認され、今回の地震のものとして拡散している。",
    ],
  },
  {
    name: "外国人による犯罪増加デマ",
    weight: 10,
    description: "混乱に乗じた外国人の窃盗・犯罪が急増しているという根拠不明の投稿。",
    templates: [
      "外国人グループが空き家を狙っているという投稿。出典・根拠は示されていない。",
      "「外国人窃盗団を見た」という目撃談が転載を重ねるうちに詳細が変化している。",
    ],
  },
  {
    name: "義援金・支援を騙る詐欺",
    weight: 9,
    description: "公的機関を装った寄付募集や、偽の支援物資申込フォームへの誘導。",
    templates: [
      "県公式を名乗るアカウントが義援金の振込先を案内しているが、公式サイトに記載なし。",
      "支援物資の申込フォームと称するリンクが、個人情報を集める詐欺サイトだった。",
    ],
  },
  {
    name: "SNS切り抜き動画の文脈誤認",
    weight: 8,
    description: "過去の別の災害の映像が、今回の熊本地震の映像として誤って紹介されている。",
    templates: [
      "投稿されている土砂崩れの映像は2016年の別地域のものと判明。",
      "海外の地震映像が「熊本市内で撮影」として拡散されている。",
    ],
  },
  {
    name: "交通規制・道路状況の誤り",
    weight: 7,
    description: "通行止め区間や高速道路の再開状況について、古い・不正確な情報が残り続けている。",
    templates: [
      "九州道の区間が「全面通行止め」のままと投稿されているが、一部区間は再開済み。",
      "橋が崩落したという未確認情報が地図アプリの投稿と共に拡散。",
    ],
  },
  {
    name: "原発関連の不安を煽る投稿",
    weight: 6,
    description: "震源から離れた原子力発電所への影響について、事実確認のない不安煽動的な投稿。",
    templates: [
      "「原発から煙が上がっている」との投稿があったが、該当施設に該当設備はない。",
      "放射線量が急上昇したという投稿だが、公式モニタリングポストの値と一致しない。",
    ],
  },
  {
    name: "献血・支援物資の過剰呼びかけ",
    weight: 5,
    description: "特定の血液型や物資が「今すぐ」不足しているという煽情的な呼びかけの拡散。",
    templates: [
      "「O型の血液が今夜中に尽きる」という投稿が経路不明のまま広く転載されている。",
    ],
  },
  {
    name: "気象・余震予測の誤り",
    weight: 5,
    description: "科学的根拠のない「次の大地震の日時」を予知したとする投稿。",
    templates: [
      "「3日後に本震を超える地震が来る」という予知投稿。気象庁はそうした予測を否定。",
    ],
  },
  {
    name: "偽の安否確認サービス誘導",
    weight: 4,
    description: "公式の安否確認サービスを装い、外部サイトへ誘導するリンク。",
    templates: ["公式の安否確認システムと称するリンクだが、ドメインが公的機関のものではない。"],
  },
  {
    name: "AI生成画像の誤認",
    weight: 3,
    description: "AIで生成された被災地の画像が、実写として拡散している。",
    templates: ["崩落した建物の画像が実は生成AIによるものだったと判明した投稿。"],
  },
  {
    name: "医療関係の不確かな助言",
    weight: 3,
    description: "断水時の飲料水確保などについて、医学的根拠の薄い対処法が拡散している。",
    templates: ["濁った水道水を煮沸なしで飲用できるとする投稿。専門家は推奨していない。"],
  },
];

function pickWeighted<T extends { weight: number }>(items: T[], rand: () => number): T {
  const total = items.reduce((sum, i) => sum + i.weight, 0);
  let r = rand() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

/** 本震からの経過分数に応じた、投稿量の相対的な強度(疑似的な減衰カーブ)。 */
function intensityAt(minutesSinceMainshock: number): number {
  if (minutesSinceMainshock < 0) return 0.05; // 地震前: ごく僅かなノイズ
  if (minutesSinceMainshock < 60) return 0.2 + (minutesSinceMainshock / 60) * 1.6; // 立ち上がり
  // 以降は緩やかに減衰しつつ、翌朝にもう一段小さな山(二次拡散)を作る
  const hours = minutesSinceMainshock / 60;
  const decay = 1.8 * Math.exp(-hours / 8);
  const secondaryWave = 0.6 * Math.exp(-Math.pow(hours - 20, 2) / 18);
  return decay + secondaryWave;
}

export type MockData = {
  notes: NotesFile;
  clusters: ClustersFile;
  timeline: TimelineFile;
  /** 累積レポート相当の疑似Markdown。ReportSection のクラスタブロック分岐の確認用。 */
  report: string;
};

/**
 * 疑似データ一式を生成する。
 *
 * MONITOR_START_AT 〜 本震+30時間 の範囲で30分ビンを埋め、各ビンの強度に応じた件数の
 * ノートを撒く。クラスタは13件用意し、うち1件はマージ済み(aliasOf)にして
 * resolveClusterId の解決経路もモック上で確認できるようにしている。
 */
export function generateMock(): MockData {
  const rand = mulberry32(20260728);
  const generatedAt = MAINSHOCK_AT + 30 * 60 * 60 * 1000;

  // BLOB_READ_WRITE_TOKEN 等が無い環境でも動くよう、開始時刻はモック専用に固定値を使う。
  // env() は他の必須変数(KV等)まで要求するため、ここでは参照しない。
  const monitorStartAt = binStart(Date.parse("2026-07-28T13:00:00+09:00"));
  const endAt = binStart(generatedAt);

  // ── クラスタ ──
  // 意図的に `% 10` のままにしている(パレットは8色に縮小済み)。旧10色パレット時代に
  // 採番された colorIndex 8/9 を持つ永続データが、新パレットでも clusterColor() の
  // mod によって(8→blueに、9→orangeに再マップされ)クラッシュせず表示できることを
  // モックの時点で確認できるようにするため。
  const clusters: Cluster[] = CLUSTER_SEEDS.map((seed, i) => ({
    id: `c_${String(i + 1).padStart(3, "0")}`,
    name: seed.name,
    description: seed.description,
    colorIndex: i % 10,
    createdAt: monitorStartAt,
    aliasOf: null,
  }));
  // 1件をマージ済みにして alias 解決の経路を再現する(id は既存と衝突しない末尾番号)。
  const mergedClusterId = `c_${String(CLUSTER_SEEDS.length + 1).padStart(3, "0")}`;
  clusters.push({
    id: mergedClusterId,
    name: "アニメ関連の誤情報(統合済み)",
    description: "再編成で「SNS切り抜き動画の文脈誤認」に統合された旧クラスタ。",
    colorIndex: 5,
    createdAt: monitorStartAt,
    aliasOf: "c_006",
  });

  // ── ノート ──
  const notes: Note[] = [];
  let noteSeq = 1;
  for (let binAt = monitorStartAt; binAt <= endAt; binAt = nextBin(binAt)) {
    const minutesSince = (binAt - MAINSHOCK_AT) / 60000;
    const intensity = intensityAt(minutesSince);
    const count = Math.max(0, Math.round(intensity * 6 + (rand() - 0.5) * 2));

    for (let i = 0; i < count; i++) {
      const seed = pickWeighted(CLUSTER_SEEDS, rand);
      const seedIndex = CLUSTER_SEEDS.indexOf(seed);
      // ごく一部は統合済みクラスタを指したままにし、ノート側は古いIDを持ち続けるという
      // 実運用の状態(aliasOf解決が必要なケース)を再現する。
      const clusterId =
        seedIndex === 5 && rand() < 0.3 ? mergedClusterId : clusters[seedIndex].id;
      const createdAt = binAt + Math.floor(rand() * BIN_MINUTES * 60 * 1000);
      const relevance = Math.round(40 + rand() * 60);
      const excluded = relevance < 60;
      const rateCount = Math.round(rand() * 12);
      const helpfulCount = Math.round(rand() * rateCount);
      const statusPool: Note["currentStatus"][] = [
        null,
        "NEEDS_MORE_RATINGS",
        "CURRENTLY_RATED_HELPFUL",
        "CURRENTLY_RATED_NOT_HELPFUL",
      ];
      const currentStatus = statusPool[Math.floor(rand() * statusPool.length)];

      notes.push({
        noteId: `mock_note_${noteSeq}`,
        postId: `mock_post_${noteSeq}`,
        createdAt,
        summary: seed.templates[Math.floor(rand() * seed.templates.length)],
        postUrl: `https://x.com/i/web/status/190000000${String(noteSeq).padStart(10, "0")}`,
        currentStatus,
        helpfulCount,
        notHelpfulCount: Math.max(0, rateCount - helpfulCount),
        rateCount,
        impressionCount: Math.round(rand() * 50000),
        statusRefreshedAt: generatedAt,
        relevance,
        excluded,
        excludeReason: excluded ? "キーワードのみ一致し地震との関連が薄いと判定" : null,
        clusterId,
        classifiedAt: createdAt + 5 * 60 * 1000,
        classifierVersion: "mock",
      });
      noteSeq++;
    }
  }

  // ── タイムライン(notes から集計。ゼロ件のビンも欠落させず埋める) ──
  const bins: TimelineBin[] = [];
  for (let binAt = monitorStartAt; binAt <= endAt; binAt = nextBin(binAt)) {
    const binEnd = nextBin(binAt);
    const inBin = notes.filter((n) => !n.excluded && n.createdAt >= binAt && n.createdAt < binEnd);
    const counts: Record<string, number> = {};
    for (const n of inBin) {
      if (!n.clusterId) continue;
      counts[n.clusterId] = (counts[n.clusterId] ?? 0) + 1;
    }
    bins.push({ startAt: binAt, total: inBin.length, counts });
  }

  // ── 累積レポート(モック用の固定テキスト) ──
  // 上位2クラスタの名前を見出しに使い、ReportSection のクラスタブロック照合ロジックを
  // モックの時点で確認できるようにしている。
  const top2 = [...CLUSTER_SEEDS].sort((a, b) => b.weight - a.weight).slice(0, 2);
  const report = [
    "熊本地震の発生直後から、SNS上では断水・避難所・支援金にまつわる誤情報が断続的に確認されている。",
    "本震発生から数時間でノートの投稿数はピークに達し、以降は緩やかな減少傾向にあるが、翌朝にかけて二次的な拡散の山が見られた。",
    "",
    `## ${top2[0].name}`,
    "",
    `${top2[0].description}特に断水復旧の見込み時期をめぐる情報の錯綜が目立ち、地域ごとの状況差が誤情報を助長している。`,
    "",
    `## ${top2[1].name}`,
    "",
    `${top2[1].description}特定の避難所名を挙げた投稿が、実際の受け入れ状況と食い違ったまま拡散するケースが複数確認された。`,
    "",
    "## まとめ",
    "",
    "- 断水情報は公式発表と時点がずれやすく、継続的な監視が必要である。",
    "- 避難所の受け入れ状況は地域差が大きく、個別の確認が欠かせない。",
    "- 過去の災害の映像や投稿が文脈を伴わず再利用される傾向が続いている。",
  ].join("\n");

  return {
    notes: { generatedAt, notes },
    clusters: { generatedAt, clusters },
    timeline: { generatedAt, binMinutes: BIN_MINUTES, bins },
    report,
  };
}
