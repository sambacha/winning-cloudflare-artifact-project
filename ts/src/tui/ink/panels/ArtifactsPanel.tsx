/** 1 Artifacts: repository list, status, newest commit and its age. */
import { artifactsPanel } from "../../rows.js"
import { PanelBox } from "../PanelBox.js"
import { innerWidth, type PanelProps } from "./props.js"

export const ArtifactsPanel = ({ input, width, height, focused }: PanelProps) => <PanelBox content={artifactsPanel(input, innerWidth(width))} width={width} height={height} focused={focused} />
