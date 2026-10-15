/** 5 Cost: R2 operations and storage vs GitHub Actions minutes, derived from the inputs. */
import { costPanel } from "../../rows.js"
import { PanelBox } from "../PanelBox.js"
import { innerWidth, type PanelProps } from "./props.js"

export const CostPanel = ({ input, width, height, focused }: PanelProps) => <PanelBox content={costPanel(input, innerWidth(width))} width={width} height={height} focused={focused} />
