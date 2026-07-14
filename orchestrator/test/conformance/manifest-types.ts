/** Type definitions for the legacy differential manifest. */

export interface ManifestNewCoreOnlyCase {
  fixture: string;
  justification: string;
}

export interface ManifestAdapter {
  description: string;
  lossiness: string[];
}

export interface ManifestDeviation {
  fixture: string;
  field: string;
  legacyValue?: any;
  newCoreValue?: any;
  justification: string;
  decisionDoc?: string;
}

export interface ManifestPredicate {
  status: "legacy-verified" | "adapter-mediated" | "unverifiable-by-port" | "new-core-only-annotated";
  provenance: string | null;
  harnessSource: string | null;
  feasibility: string;
  stubs?: string[];
  approach?: string;
  fixtures: string[];
  newCoreOnlyCases?: ManifestNewCoreOnlyCase[];
  adapter?: ManifestAdapter;
  deviations?: ManifestDeviation[];
  justification?: string;
  fallback?: string;
}

export interface Manifest {
  description: string;
  pinnedCommit: string;
  sourceRepo: string;
  accessMethod: string;
  harnessDir: string;
  harnessTsconfig: string;
  harnessOutDir: string;
  harnessDeps: string;
  predicates: Record<string, ManifestPredicate>;
}
