import { z } from "zod";

/**
 * 事例設定の項目のうち、DB の読み出し（repo.ts）と作成スクリプト（scripts/tenant-upsert.ts）で
 * 同じ制約をかけるもの。片方だけ緩いと、スクリプトを通さずに書かれた行が後段で壊れる。
 */

/** 公開ページのリンクになるので、javascript: などを通さない */
export const httpUrlSchema = z.url({ protocol: /^https?$/ });

/** OpenRouter に HTTP-Referer（https://github.com/{これ}）として送る */
export const githubRepoSchema = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, "owner/repo の形にしてください");

/** OpenRouter に X-Title ヘッダとして送る。ヘッダ値に入らない文字（非 ASCII・改行）があると fetch が落ちる */
export const appTitleSchema = z.string().regex(/^[\x20-\x7E]+$/, "印字可能な ASCII だけにしてください");
