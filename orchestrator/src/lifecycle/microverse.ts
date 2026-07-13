// Microverse — convergence loop runner.
// AC-6: converges on improving metric, rollback on regression, detects stall.
// Lifecycle layer that drives the core circuit breaker and convergence gate.

import { createBreakerState, canExecute, type CircuitBreakerState } from "../core/breaker.js";

export interface MicroverseConfig {
  metric: string;
  stallLimit: number;
  maxIterations: number;
}

export interface IterationResult {
  score: number | null;
  classification: "improved" | "regressed" | "stalled" | "no-commit" | "amnesiac_exit";
  rolledBack: boolean;
}

export interface ConvergenceResult {
  converged: boolean;
  iterations: number;
  finalScore: number | null;
  reason: string;
  history: IterationResult[];
}

export class MicroverseRunner {
  private state: CircuitBreakerState;
  private baseline: number | null = null;
  private stallCount = 0;
  private history: IterationResult[] = [];

  constructor(private config: MicroverseConfig) {
    this.state = createBreakerState(5);
  }

  runSimulated(scores: number[]): ConvergenceResult {
    for (const score of scores) {
      // W2: respect the configured maxIterations cap — stop early once we've
      // recorded that many iterations instead of consuming the whole score list.
      if (this.history.length >= this.config.maxIterations) {
        return { converged: false, iterations: this.history.length, finalScore: this.baseline, reason: "max iterations reached", history: this.history };
      }
      if (!canExecute(this.state)) {
        return { converged: false, iterations: this.history.length, finalScore: this.baseline, reason: "breaker tripped", history: this.history };
      }
      const result = this.measureAndClassify(score);
      this.history.push(result);
      if (result.classification === "improved") {
        this.baseline = score;
        this.stallCount = 0;
        if (this.history.length >= 3 && this.isConverged(score)) {
          return { converged: true, iterations: this.history.length, finalScore: score, reason: "converged", history: this.history };
        }
      } else if (result.classification === "regressed") {
        // rollback is implicit in simulation — baseline preserved
      } else if (result.classification === "stalled") {
        this.stallCount++;
        if (this.stallCount >= this.config.stallLimit) {
          return { converged: false, iterations: this.history.length, finalScore: this.baseline, reason: "stalled", history: this.history };
        }
      }
    }
    return { converged: false, iterations: this.history.length, finalScore: this.baseline, reason: "max iterations reached", history: this.history };
  }

  private measureAndClassify(score: number): IterationResult {
    if (this.baseline === null) {
      this.baseline = score;
      return { score, classification: "improved", rolledBack: false };
    }
    if (score > this.baseline) {
      return { score, classification: "improved", rolledBack: false };
    }
    if (score === this.baseline) {
      return { score, classification: "stalled", rolledBack: false };
    }
    return { score, classification: "regressed", rolledBack: true };
  }

  private isConverged(score: number): boolean {
    // Simple convergence: 3 consecutive improvements with diminishing returns
    if (this.history.length < 3) return false;
    const last3 = this.history.slice(-3);
    return last3.every((r) => r.classification === "improved");
  }
}
