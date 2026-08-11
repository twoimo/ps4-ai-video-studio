import { analyzeBenchmarkRLM } from "../src/rlm-analysis.mjs";

const result = await analyzeBenchmarkRLM({ chunkSize: Number(process.env.RLM_CHUNK_SIZE || 32) });
console.log(JSON.stringify({ engine: result.reduction.engine, inputCount: result.reduction.inputCount, levels: result.reduction.levels.map((level) => level.length), rootCount: result.reduction.root.count, output: "data/rlm-benchmark-analysis.json" }, null, 2));
