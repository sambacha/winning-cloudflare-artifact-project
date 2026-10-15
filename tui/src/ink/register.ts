/**
 * `node --import ./src/ink/register.ts …` makes `.tsx` files importable.
 * `main.ts` registers the hook itself, so `node src/main.ts` works too.
 */
import { register } from "node:module"

register("./hooks.ts", import.meta.url)
