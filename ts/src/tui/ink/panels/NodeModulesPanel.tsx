/** 2 R2 node_modules cache: lockfile hash, platform, node version, size, hit/miss, restore time, seconds saved. */
import { nodeModulesPanel } from "../../rows.js"
import { PanelBox } from "../PanelBox.js"
import { innerWidth, type PanelProps } from "./props.js"

export const NodeModulesPanel = ({ input, width, height, focused }: PanelProps) => <PanelBox content={nodeModulesPanel(input, innerWidth(width))} width={width} height={height} focused={focused} />
