/** 4 Bayesian bisect: per-commit alpha/beta bars, confidence, next commit, entropy delta (from the status route; no posterior computed here). */
import { bisectPanel } from "../../rows.js"
import { PanelBox } from "../PanelBox.js"
import { innerWidth, type PanelProps } from "./props.js"

export const BisectPanel = ({ input, ui, width, height, focused }: PanelProps) => <PanelBox content={bisectPanel(input, ui, innerWidth(width))} width={width} height={height} focused={focused} />
