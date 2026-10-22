import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
function run(command,args,cwd=root,extra={}) {
 const result=spawnSync(command,args,{cwd,stdio:'inherit',env:{...process.env,...extra}});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status||1);
}
// npm_execpath avoids Windows .cmd spawning and preserves the active npm version.
run(process.execPath,[process.env.npm_execpath,'run','build'],root,{BASE_PATH:'/'});
const backend=fileURLToPath(new URL('../backend/',import.meta.url));
mkdirSync(`${backend}/build`,{recursive:true});
run('go',['build','-trimpath','-tags','lambda.norpc','-ldflags=-s -w','-o','build/bootstrap','./cmd/api'],backend,{GOOS:'linux',GOARCH:'arm64',CGO_ENABLED:'0'});
run('go',['run','./cmd/package'],backend);
