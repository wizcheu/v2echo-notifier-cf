import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

try {
  await writeFile(
    new URL("../.dev.vars", import.meta.url),
    `ADMIN_TOKEN="${randomBytes(32).toString("hex")}"\nNOTIFIER_KEY="${randomBytes(32).toString("hex")}"\nV2EX_COOKIE=""\nV2EX_PAT=""\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "已创建 .dev.vars（权限 0600）。管理密钥仅写入文件；按需自行填写 V2EX 凭据。",
  );
} catch (error) {
  if (error.code === "EEXIST") console.log(".dev.vars 已存在，保留原内容。");
  else throw error;
}
