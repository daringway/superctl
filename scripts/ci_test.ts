import { testProject } from "../src/verify.ts";

if (import.meta.main) {
  await testProject();
}
