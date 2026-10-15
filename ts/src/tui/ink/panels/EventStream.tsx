/** Event stream: append-only, timestamped, colour-coded rows (newest last). */
import { eventPanel } from "../../rows.js"
import { PanelBox } from "../PanelBox.js"
import { innerWidth, type PanelProps } from "./props.js"

export const EventStream = ({ input, width, height, focused }: PanelProps) => <PanelBox content={eventPanel(input.events, innerWidth(width))} width={width} height={height} focused={focused} />
