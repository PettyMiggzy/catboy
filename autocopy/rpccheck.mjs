// Reads the RPC_URL / RPC_WSS secrets and verifies they're Robinhood Chain (4663). Redacts the key.
const RPC=(process.env.RPC_URL||"").trim(), WSS=(process.env.RPC_WSS||"").trim();
const host=u=>{try{return new URL(u).hostname;}catch{return "(unparseable)";}};
if(!RPC){console.log("❌ RPC_URL secret is EMPTY — not set in GitHub");process.exit(0);}
const call=async(m)=>{const r=await fetch(RPC,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:[]})});return r.json();};
(async()=>{
 console.log("RPC_URL host:", host(RPC), "(key redacted)");
 try{
  const cid=await call("eth_chainId");
  if(cid?.result){const id=parseInt(cid.result,16);console.log("eth_chainId:",id, id===4663?"✅ ROBINHOOD CHAIN — GOOD TO USE":"❌ WRONG CHAIN (need 4663) — do NOT use");}
  else console.log("eth_chainId error:",JSON.stringify(cid).slice(0,150));
  const bn=await call("eth_blockNumber");
  console.log("eth_blockNumber:", bn?.result?parseInt(bn.result,16):JSON.stringify(bn).slice(0,120));
 }catch(e){console.log("❌ RPC unreachable / not JSON-RPC:",e.message);}
 console.log("RPC_WSS:", WSS?`set, host ${host(WSS)}, ${WSS.startsWith("wss")?"✅ wss scheme":"⚠️ not wss://"}`:"not set");
})();
