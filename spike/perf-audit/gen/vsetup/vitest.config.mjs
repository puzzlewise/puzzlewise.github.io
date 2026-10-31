export default {
  root: '/Users/bot/src/puzzle',
  test: {
    setupFiles: [process.env.NOPATCH ? '/tmp/perf-audit/gen/vsetup/nop.ts' : '/tmp/perf-audit/gen/vsetup/patch.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**'],
  },
  server: { fs: { allow: ['/tmp', '/private/tmp', '/Users/bot/src/puzzle'] } },
};
