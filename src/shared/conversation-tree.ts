export type TreeNode = { id:string; parentId?:string|null };
/** Old linear histories acquire parents in place; explicit null denotes a root. */
export function withParents<T extends TreeNode>(nodes:T[]):T[] {
 return nodes.map((node,i)=>Object.hasOwn(node,'parentId')?node:{...node,parentId:i?nodes[i-1].id:null});
}
export function conversationPath<T extends TreeNode>(nodes:T[],leafId?:string|null):T[] {
 const normalized=withParents(nodes),byId=new Map(normalized.map(n=>[n.id,n]));
 let id:string|null|undefined=leafId ?? normalized.at(-1)?.id;const path:T[]=[],seen=new Set<string>();
 while(id){if(seen.has(id))throw new Error('对话树存在循环');seen.add(id);const node=byId.get(id);if(!node)throw new Error('对话版本不存在');path.unshift(node);id=node.parentId;}
 return path;
}
export function latestDescendant<T extends TreeNode>(nodes:T[],id:string):string {
 const normalized=withParents(nodes);const seen=new Set<string>();
 while(true){if(seen.has(id))throw new Error('对话树存在循环');seen.add(id);const child=[...normalized].reverse().find(n=>n.parentId===id);if(!child)return id;id=child.id;}
}
export function branchKey<T extends TreeNode>(nodes:T[],leafId?:string|null):string {
 const normalized=withParents(nodes),path=conversationPath(normalized,leafId);
 return path.filter(n=>normalized.filter(candidate=>candidate.parentId===n.parentId).length>1).map(n=>n.id).join(':');
}
