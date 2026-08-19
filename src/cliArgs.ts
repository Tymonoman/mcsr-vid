/** Reads argv[2] or prints a `npm run <cmd> -- <usageDesc>` usage line and exits(1). Every CLI entry script needs this same argv check. */
export function requireArg(
  cmd: string,
  usageDesc = "<mcsrranked.com match URL or match ID>",
): string {
  const input = process.argv[2];
  if (!input) {
    console.error(`Usage: npm run ${cmd} -- ${usageDesc}`);
    process.exit(1);
  }
  return input;
}
