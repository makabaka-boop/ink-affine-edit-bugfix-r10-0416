import type { Sample } from "../model/types";

export interface SmoothRequest {
  type: "smooth";
  strokeId: string;
  /** 请求发起时文档的编辑代次。 */
  gen: number;
  points: Sample[];
}

export interface SmoothResponse {
  type: "smoothed";
  strokeId: string;
  gen: number;
  points: Sample[];
}
