import {spawnSync} from 'node:child_process';
import path from 'node:path';
// Front integration uses the adopter-owned IPC codec; no real Native writes.
if(!process.env.BETTER_CODEX_TEST_HOST_PACKAGE)throw Error('Set BETTER_CODEX_TEST_HOST_PACKAGE to your locally installed OpenCodex package.json');
const names=["native-optional-metadata-mapping","common-file-preview","official-live-config","control-path-timing", "execution-metadata-control", "submission-context-front", "owned-visualization-root", "client-diagnostics-retention", "diagnostic-inflight-ack", "diagnostic-upload-deadline", "front-connection-diagnostics", "page-wire-diagnostics", "diagnostic-closure", "native-queue-client-recovery", "confirmed-user-reopen", "quiet-history-validation", "stream-completion-recovery", "completion-handoff", "pending-thread-ownership", "catalog-retirement-busy", "native-read-receipt"];
const result=spawnSync(process.execPath,['--import',path.resolve('source/apps/native-codex-web/test/fixtures/portable-test-environment.mjs'),'--test',...names.map(n=>'source/apps/native-codex-web/test/'+n+'.test.mjs')],{stdio:'inherit'});if(result.error)throw result.error;process.exitCode=result.status||0;
