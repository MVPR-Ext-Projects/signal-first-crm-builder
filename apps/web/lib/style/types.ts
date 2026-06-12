export type DimensionType = 'spectrum' | 'categorical';

export interface SpectrumDimension {
  name: string;
  group: string;
  type: 'spectrum';
  pole_low: string;
  pole_high: string;
  low_desc: string;
  high_desc: string;
}

export interface CategoricalDimension {
  name: string;
  group: string;
  type: 'categorical';
  A: string;
  B: string;
  C?: string;
  D?: string;
}

export type Dimension = SpectrumDimension | CategoricalDimension;

// Analysis result shapes (from Claude)
export interface SpectrumResult {
  name: string;
  group: string;
  type: 'spectrum';
  score: number;
  pole_low: string;
  pole_high: string;
  confidence: number;
  example: string;
  transformation_rule: string;
}

export interface CategoricalResult {
  name: string;
  group: string;
  type: 'categorical';
  option: 'A' | 'B' | 'C' | 'D';
  confidence: number;
  example: string;
  transformation_rule: string;
}

export type DimensionResult = SpectrumResult | CategoricalResult;

export interface StyleProfile {
  author_name: string;
  word_count: number;
  summary: string;
  key_traits: string[];
  dimensions: DimensionResult[];
  dimension_count: number;
}
