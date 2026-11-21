import { register } from "node:module";

const protoUrl = new URL("../../../packages/protocol/src/index.ts", import.meta.url).href;
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export function resolve(specifier, context, nextResolve) {
         if (specifier === "@herdr-pocket/protocol") return nextResolve(${JSON.stringify(protoUrl)}, context);
         return nextResolve(specifier, context);
       }`,
    ),
);
