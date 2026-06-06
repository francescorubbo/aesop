import { readFileSync } from 'node:fs';
import { CampaignEntry } from './types.js';

export interface CampaignRatchetResult {
  improved: boolean;
  current: number;
  historicalBest: number | null; // null = no prior completed campaigns
  bestCampaignId: string | null;
}

/**
 * Checks if the current best metric for a campaign improves upon the best metric
 * achieved across all previously completed campaigns in the ledger.
 *
 * @param campaignLedgerPath - Path to the campaign ledger (JSONL)
 * @param metricKey - The metric to track for monotonicity
 * @param currentBest - The best value achieved in the current campaign
 * @param options - Ratchet configuration (default maximize: true)
 * @returns Result indicating if improvement was achieved
 */
export function checkCampaignRatchet(
  campaignLedgerPath: string,
  metricKey: string,
  currentBest: number,
  options: { maximize?: boolean } = {}
): CampaignRatchetResult {
  const { maximize = true } = options;
  let historicalBest: number | null = null;
  let bestCampaignId: string | null = null;

  try {
    const content = readFileSync(campaignLedgerPath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const entry: CampaignEntry = JSON.parse(line);

        // Only consider completed campaigns that have the requested metric
        if (
          entry.status === 'completed' &&
          entry.bestMetrics &&
          entry.bestMetrics[metricKey] !== undefined
        ) {
          const value = entry.bestMetrics[metricKey];

          if (historicalBest === null) {
            historicalBest = value;
            bestCampaignId = entry.campaignId;
          } else {
            const isBetter = maximize ? value > historicalBest : value < historicalBest;

            if (isBetter) {
              historicalBest = value;
              bestCampaignId = entry.campaignId;
            }
          }
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }
  } catch {
    // File might not exist yet, which is fine (first campaign)
  }

  const improved =
    historicalBest === null
      ? true
      : maximize
        ? currentBest > historicalBest
        : currentBest < historicalBest;

  return {
    improved,
    current: currentBest,
    historicalBest,
    bestCampaignId,
  };
}
