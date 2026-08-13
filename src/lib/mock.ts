import { BIN_MINUTES } from "./constants";
import { EVENT } from "./event";
import { binStart, nextBin } from "./time";
import type {
  Cluster,
  ClustersFile,
  CrossPost,
  CrossPostsFile,
  Note,
  NotesFile,
  TimelineBin,
  TimelineFile,
} from "./types";

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
  /** 非X独立セクション(CrossPlatformTab)のレビュー用疑似データ。 */
  crossPosts: CrossPostsFile;
};

/**
 * CrossPlatformTab の見た目確認用フィクスチャ。
 * stance/urgency/公式リンクの分岐に加え、指標(views/likes/comments/shares/collects/flame_rate)の
 * PF別偏在(youtube/tiktok は充実・threads は likes のみ・web は指標なし)も再現する。
 * 並びは publishSnapshot と同じ「拡散源→打消し→報道→その他、その後 published_at 降順」を模す。
 */
function mockCrossPosts(generatedAt: number): CrossPostsFile {
  const h = (n: number) => generatedAt - n * 60 * 60 * 1000;
  const posts: CrossPost[] = [
    // ── SPREADING（拡散源）を上位に ──
    {
      insightId: "mock_yt_1", platform: "youtube", url: "https://www.youtube.com/watch?v=MOCK0000001",
      stance: "SPREADING", urgency: "HIGH", claimType: "FALSE_DAMAGE",
      officialRelationship: "conflicts_with_official", officialUrl: "https://www.jma.go.jp/",
      claimSummary: "動物園からライオンが脱走したとする動画。園は公式に否定しており、2016年の古い投稿の再拡散とみられる。",
      publishedAt: h(2), views: 452000, likes: 3820, comments: 512, flameRate: 0.0113,
    },
    {
      insightId: "mock_tt_1", platform: "tiktok", url: "https://www.tiktok.com/@mockuser/video/700000000000000001",
      stance: "SPREADING", urgency: "HIGH", claimType: "SCAM",
      officialRelationship: "conflicts_with_official", officialUrl: "https://www.city.kumamoto.jp/",
      claimSummary: "県公式を装い義援金の振込先を案内する投稿。公式サイトに該当する振込先の記載はない。",
      publishedAt: h(3), views: 165100, likes: 1885, comments: 494, shares: 69, collects: 129, flameRate: 0.2621,
    },
    {
      insightId: "mock_tt_3", platform: "tiktok", url: "https://www.tiktok.com/@spread/video/700000000000000003",
      stance: "SPREADING", urgency: "MEDIUM", claimType: "RUMOR",
      officialRelationship: "conflicts_with_official", officialUrl: "https://www.pref.kumamoto.jp/",
      claimSummary: "「3日後に本震を超える地震が来る」とする予知動画。気象庁はそうした地震予知はできないとしている。",
      publishedAt: h(4), views: 88400, likes: 902, comments: 141, shares: 23, collects: 40, flameRate: 0.1563,
    },
    {
      insightId: "mock_th_1", platform: "threads", url: "https://www.threads.com/@mockhandle/post/ABCDEFG0001",
      stance: "SPREADING", urgency: "MEDIUM", claimType: "RUMOR",
      officialRelationship: "insufficient_official_evidence", officialUrl: "https://www.city.kumamoto.jp/",
      claimSummary: "外国人グループが被災した空き家を狙って窃盗しているとする投稿。出典・根拠は示されていない。",
      publishedAt: h(5), likes: 760,
    },
    {
      insightId: "mock_yt_3", platform: "youtube", url: "https://www.youtube.com/watch?v=MOCK0000003",
      stance: "SPREADING", urgency: "MEDIUM", claimType: "FALSE_DAMAGE",
      officialRelationship: "conflicts_with_official", officialUrl: "https://www.jma.go.jp/",
      claimSummary: "原発から煙が上がっているとする投稿。該当施設に当該設備はなく、公式モニタリング値とも一致しない。",
      publishedAt: h(6), views: 39800, likes: 640, comments: 96, flameRate: 0.0024,
    },
    // ── DEBUNKING（打消し） ──
    {
      insightId: "mock_tt_2", platform: "tiktok", url: "https://www.tiktok.com/@another/video/700000000000000002",
      stance: "DEBUNKING", urgency: "NONE", claimType: "DEBUNK",
      officialRelationship: "no_official_source", officialUrl: null,
      claimSummary: "脱走デマは2016年の古い投稿の再拡散だと指摘し、注意を促す打消し投稿。",
      publishedAt: h(7), views: 21000, likes: 540, comments: 33, shares: 12, collects: 61, flameRate: 0.0611,
    },
    {
      insightId: "mock_yt_2", platform: "youtube", url: "https://www.youtube.com/watch?v=MOCK0000002",
      stance: "DEBUNKING", urgency: "LOW", claimType: "DEBUNK",
      officialRelationship: "insufficient_official_evidence", officialUrl: "https://www.pref.kumamoto.jp/",
      claimSummary: "断水がいつ復旧するかを解説する動画。公式の復旧見込みは未確定で、誤った時期が拡散していると指摘。",
      publishedAt: h(9), views: 9521, likes: 210, comments: 16, flameRate: 0.0017,
    },
    // ── REPORTING（報道） ──
    {
      insightId: "mock_web_1", platform: "web", url: "https://example.com/news/mock-article-1",
      stance: "REPORTING", urgency: "MEDIUM", claimType: "DAMAGE_REPORT",
      officialRelationship: "insufficient_official_evidence", officialUrl: "https://www.mlit.go.jp/",
      claimSummary: "九州道の一部区間が全面通行止めのままとする記事。実際には一部区間は既に再開済み。",
      publishedAt: h(8),
    },
    {
      insightId: "mock_web_3", platform: "web", url: "https://example.com/news/mock-article-3",
      stance: "REPORTING", urgency: "LOW", claimType: "DAMAGE_REPORT",
      officialRelationship: "matches_official", officialUrl: null,
      claimSummary: "災害関連死の疑いを含め39人が死亡、避難所に3652人が避難しているとする報道。",
      publishedAt: h(10),
    },
    {
      insightId: "mock_th_2", platform: "threads", url: "https://www.threads.com/@handle2/post/ABCDEFG0002",
      stance: "REPORTING", urgency: "LOW", claimType: "DAMAGE_REPORT",
      officialRelationship: "no_official_source", officialUrl: null,
      claimSummary: "八代市が令和8年熊本地震に関する問い合わせ先を案内しているとする投稿。",
      publishedAt: h(12), likes: 84,
    },
    // ── その他（NEUTRAL / stance なし） ──
    {
      insightId: "mock_web_2", platform: "web", url: "https://example.com/blog/mock-article-2",
      stance: "NEUTRAL", urgency: "NONE", claimType: "OTHER",
      officialRelationship: "no_official_source", officialUrl: null,
      claimSummary: "断水時に濁った水道水を煮沸なしで飲めるとする記事。専門家は推奨していない。",
      publishedAt: null,
    },
    {
      insightId: "mock_th_3", platform: "threads", url: "https://www.threads.com/@handle3/post/ABCDEFG0003",
      stance: null, urgency: "LOW", claimType: "RUMOR",
      officialRelationship: "no_official_source", officialUrl: null,
      claimSummary: "避難所が満員で入れないという未確認の投稿。市の発表では空きがある。",
      publishedAt: h(13), likes: 12,
    },
    // ── スパークライン/最多種別/件数差を出すための追加ダミー ──
    // TikTok を厚めに（拡散の主戦場）。時間を散らして投稿量の推移を作る。
    {
      insightId: "mock_tt_4", platform: "tiktok", url: "https://www.tiktok.com/@x/video/700000000000000004",
      stance: "SPREADING", urgency: "HIGH", claimType: "RUMOR",
      officialRelationship: "conflicts_with_official", officialUrl: "https://www.pref.kumamoto.jp/",
      claimSummary: "井戸水に毒が混ざっているので飲むなとする投稿。県はそうした事実はないと否定している。",
      publishedAt: h(1), views: 3410000, likes: 121000, comments: 8300, shares: 9100, collects: 4200, flameRate: 0.0024,
    },
    {
      insightId: "mock_tt_5", platform: "tiktok", url: "https://www.tiktok.com/@x/video/700000000000000005",
      stance: "SPREADING", urgency: "MEDIUM", claimType: "RUMOR",
      officialRelationship: "no_official_source", officialUrl: null,
      claimSummary: "コンビニで略奪が起きているとする映像。別地域の過去映像の流用とみられる。",
      publishedAt: h(2), views: 884000, likes: 61000, comments: 2100, shares: 3300, collects: 900, flameRate: 0.0024,
    },
    {
      insightId: "mock_tt_6", platform: "tiktok", url: "https://www.tiktok.com/@x/video/700000000000000006",
      stance: "REPORTING", urgency: "LOW", claimType: "DAMAGE_REPORT",
      officialRelationship: "insufficient_official_evidence", officialUrl: "https://www.mlit.go.jp/",
      claimSummary: "避難所の混雑状況を伝える現地の投稿。",
      publishedAt: h(5), views: 223000, likes: 5400, comments: 210, shares: 120, collects: 88, flameRate: 0.0009,
    },
    {
      insightId: "mock_yt_4", platform: "youtube", url: "https://www.youtube.com/watch?v=MOCK0000004",
      stance: "SPREADING", urgency: "HIGH", claimType: "FALSE_DAMAGE",
      officialRelationship: "conflicts_with_official", officialUrl: "https://www.mlit.go.jp/",
      claimSummary: "ダムが決壊寸前だとするうわさを煽る動画。管理者は異常なしと発表している。",
      publishedAt: h(3), views: 301000, likes: 8800, comments: 640, flameRate: 0.0021,
    },
    {
      insightId: "mock_yt_5", platform: "youtube", url: "https://www.youtube.com/watch?v=MOCK0000005",
      stance: "DEBUNKING", urgency: "NONE", claimType: "DEBUNK",
      officialRelationship: "no_official_source", officialUrl: null,
      claimSummary: "ライオン脱走はデマだと映像の出所を検証する解説動画。",
      publishedAt: h(4), views: 81000, likes: 3300, comments: 120, flameRate: 0.0015,
    },
    {
      insightId: "mock_th_4", platform: "threads", url: "https://www.threads.com/@h/post/ABCDEFG0002",
      stance: "DEBUNKING", urgency: "LOW", claimType: "IMPERSONATION",
      officialRelationship: "insufficient_official_evidence", officialUrl: "https://www.city.kumamoto.jp/",
      claimSummary: "自治体になりすました募金アカウントへの注意喚起。",
      publishedAt: h(6), likes: 340,
    },
    {
      insightId: "mock_th_5", platform: "threads", url: "https://www.threads.com/@h/post/ABCDEFG0003",
      stance: "REPORTING", urgency: "NONE", claimType: "DAMAGE_REPORT",
      officialRelationship: "no_official_source", officialUrl: null,
      claimSummary: "断水エリアの給水所情報のまとめ。",
      publishedAt: h(9), likes: 120,
    },
    {
      insightId: "mock_web_4", platform: "web", url: "https://example.com/news/mock-article-4",
      stance: "DEBUNKING", urgency: "NONE", claimType: "FALSE_RESCUE",
      officialRelationship: "insufficient_official_evidence", officialUrl: "https://www.pref.kumamoto.jp/",
      claimSummary: "県が救助要請の偽情報に注意を呼びかけたと伝えるファクトチェック記事。",
      publishedAt: h(10),
    },
  ];
  return { generatedAt, posts };
}

/**
 * 疑似データ一式を生成する。
 *
 * MONITOR_START_AT 〜 本震+30時間 の範囲で30分ビンを埋め、各ビンの強度に応じた件数の
 * ノートを撒く。クラスタは13件用意し、うち1件はマージ済み(aliasOf)にして
 * resolveClusterId の解決経路もモック上で確認できるようにしている。
 */
export function generateMock(): MockData {
  const rand = mulberry32(20260728);
  const generatedAt = EVENT.occurredAt + 30 * 60 * 60 * 1000;

  // BLOB_READ_WRITE_TOKEN 等が無い環境でも動くよう、開始時刻は env() を参照せずモック専用に
  // 算出する（env() は他の必須変数(KV等)まで要求するため）。EVENT.occurredAt より数時間前から
  // 収集していた状態を再現できればよいので、発生時刻からの相対値で決める。
  const monitorStartAt = binStart(EVENT.occurredAt - 3.45 * 60 * 60 * 1000);
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
    const minutesSince = (binAt - EVENT.occurredAt) / 60000;
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
    crossPosts: mockCrossPosts(generatedAt),
  };
}
