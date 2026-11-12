import { solveInventory } from './solver.js?v=6';

self.onmessage = ({ data }) => {
  try {
    const result = solveInventory(data.counts, data.options);
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
