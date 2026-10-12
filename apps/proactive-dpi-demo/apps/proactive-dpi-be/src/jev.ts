// Minimal Jev client: TypeSafe System One. The incident agent does not use this key.
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
};
export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };
export type JevResult = {
  model: string;
  answers: Record<string, ChoiceAnswer | ScoreAnswer>;
  cost: number | null;
  latencyMs: number;
};

const RETRY = new Set([429, 502, 503, 529]);

export class Jev {
  readonly provider = "typesafe" as const;
  private readonly endpoint = "https://api.typesafe.ai/v1/systemone";
  private readonly key: string;
  private readonly model = "jev-latest";

  constructor() {
    const key = process.env.TYPESAFE_API_KEY;
    if (!key) throw Error("Jev needs TYPESAFE_API_KEY");
    this.key = key;
  }

  async ask(state: unknown, questions: Record<string, Question>): Promise<JevResult> {
    const started = performance.now();
    const body = JSON.stringify({ model: this.model, state, questions });
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (RETRY.has(res.status) && attempt < 3) {
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw Error(`Jev HTTP ${res.status}`);
      const data = (await res.json()) as {
        model: string;
        answers: JevResult["answers"];
        usage?: { cost?: unknown };
      };
      for (const [id, question] of Object.entries(questions))
        if (data.answers?.[id]?.type !== question.type) throw Error(`Jev answer missing: ${id}`);
      const cost = data.usage?.cost;
      return {
        model: data.model,
        answers: data.answers,
        cost: typeof cost === "number" && cost >= 0 ? cost : null,
        latencyMs: Math.round(performance.now() - started),
      };
    }
  }
}
