export function diskSize(input:string) {
 const match=input.trim().match(/^(\d+(?:\.\d+)?)\s*(m|mb|mib|g|gb|gib)?$/i);
 if(!match)throw new Error('容量格式：512 MB、1 GB；不写单位默认为 MB');
 const mb=Number(match[1])*(match[2]?.toLowerCase().startsWith('g')?1024:1);
 if(!Number.isInteger(mb)||mb<64||mb>65536)throw new Error('容量应为 64 MB–64 GB，精确到 MB');
 return `${mb}M`;
}
