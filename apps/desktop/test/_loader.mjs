import { register } from "node:module";

const protoUrl = new URL("../../../packages/protocol/src/index.ts", import.meta.url).href;
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(specifier, context, nextResolve) {
         if (specifier === "@herdr-pocket/protocol") return nextResolve(${JSON.stringify(protoUrl)}, context);
         try {
           return await nextResolve(specifier, context);
         } catch (err) {
           if (err && err.code === "ERR_MODULE_NOT_FOUND" && (specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[a-z]+$/i.test(specifier)) {
             for (const ext of [".ts", ".tsx"]) {
               try {
                 return await nextResolve(specifier + ext, context);
               } catch {
                 // try next extension
               }
             }
           }
           throw err;
         }
       }`,
    ),
);
