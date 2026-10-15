/** 3 Operation leases: owner, status, countdown, heartbeat pulse, lease bar. */
import { leasePanel } from "../../rows.js"
import { PanelBox } from "../PanelBox.js"
import { innerWidth, type PanelProps } from "./props.js"

export const LeasePanel = ({ input, width, height, focused }: PanelProps) => <PanelBox content={leasePanel(input, innerWidth(width))} width={width} height={height} focused={focused} />
