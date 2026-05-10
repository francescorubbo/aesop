/**
 * Aesop - Distributed ML Experiment Orchestration for Pi
 *
 * Aesop enables Pi to autonomously branch, dispatch, and evaluate distributed
 * machine learning experiments. It provides tools for experiment versioning,
 * parallel execution across compute environments, and automated result aggregation.
 */

/**
 * Extension manifest following Pi's extension format.
 * This defines the extension's identity and capabilities.
 */
const manifest = {
  name: "Aesop",
  description: "Enables Pi to autonomously branch, dispatch, and evaluate distributed ML experiments",
  tools: [] as string[],
};

export default function (): void {
  // Log manifest on load
  console.log(`[Aesop] Extension loaded: ${manifest.name} - ${manifest.description}`);
}

export { manifest };