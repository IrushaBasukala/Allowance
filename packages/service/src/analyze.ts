const POSITIVE = new Set([
  "good",
  "great",
  "excellent",
  "love",
  "wonderful",
  "best",
  "happy",
  "reliable",
  "fast",
  "secure",
  "clear",
  "helpful",
  "safe",
  "trusted",
]);

const NEGATIVE = new Set([
  "bad",
  "terrible",
  "awful",
  "hate",
  "worst",
  "broken",
  "slow",
  "unreliable",
  "scam",
  "fraud",
  "stolen",
  "drained",
  "compromised",
  "fake",
]);

export interface Analysis {
  sentiment: "positive" | "negative" | "neutral";
  /** -1000..1000 */
  score: number;
  tokens: number;
  salient: string[];
}

export function analyze(text: string): Analysis {
  const words = text
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter(Boolean);

  let hits = 0;
  const salient: string[] = [];

  for (const w of words) {
    if (POSITIVE.has(w)) {
      hits += 1;
      salient.push(w);
    } else if (NEGATIVE.has(w)) {
      hits -= 1;
      salient.push(w);
    }
  }

  const score =
    words.length === 0 ? 0 : Math.round((hits / words.length) * 1000);
  const sentiment =
    score > 50 ? "positive" : score < -50 ? "negative" : "neutral";

  return {
    sentiment,
    score,
    tokens: words.length,
    salient: [...new Set(salient)].slice(0, 8),
  };
}
