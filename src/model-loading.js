// Transformers.js requires local loading enabled before it will consult the cache
// in local_files_only mode. Missing local files must not hit the site's SPA route.
const LOCAL_MISS='https://little-lens.invalid/local-models/';
export function configureModelLoading(env,cachedOnly,scope=globalThis){
 env.allowLocalModels=!!cachedOnly;
 env.allowRemoteModels=!cachedOnly;
 env.localModelPath=LOCAL_MISS;
 if(!scope.__littleLensLocalFetch){
  const fetch=scope.fetch.bind(scope);
  scope.fetch=(input,...args)=>{
   const url=typeof input==='string'?input:input.url||String(input);
   return url.startsWith(LOCAL_MISS)?Promise.resolve(new Response(null,{status:404})):fetch(input,...args);
  };
  scope.__littleLensLocalFetch=true;
 }
}
