function compactInline(formula: string) {
  return formula.replace(/\\dfrac/g, '\\frac').replace(/\\displaystyle\s*/g, '');
}

/** remark-math reads dollar delimiters; models also emit LaTeX delimiters. */
function normalizeText(source: string) {
  let result='';
  for (let index=0;index<source.length;) {
    if (source[index]==='\\' && source[index+1]==='\\') {
      result+=source.slice(index,index+2);index+=2;continue;
    }
    const opening=source.slice(index,index+2);
    if (opening==='\\(' || opening==='\\[') {
      const closing=opening==='\\(' ? '\\)' : '\\]';
      let end=source.indexOf(closing,index+2);
      while (end>=0) {
        let escapes=0;
        for(let before=end-1;before>=0 && source[before]==='\\';before--) escapes++;
        if(escapes%2===0) break;
        end=source.indexOf(closing,end+2);
      }
      if (end>=0) {
        const formula=source.slice(index+2,end).trim();
        result+=opening==='\\[' ? `\n$$\n${formula}\n$$\n` : `$${compactInline(formula).replace(/\r?\n/g,' ')}$`;
        index=end+2;continue;
      }
    }
    result+=source[index++];
  }
  return result.replace(/(^|[^\\$])\$([^$\n]+)\$(?!\$)/g, (_match,prefix:string,formula:string)=>`${prefix}$${compactInline(formula)}$`);
}

/** Preserve code verbatim, including an unfinished fenced block while streaming. */
export function normalizeMathMarkdown(source: string) {
  const output:string[]=[];
  let plainStart=0,index=0;
  while(index<source.length) {
    let end:number|undefined;
    if(index===0 || source[index-1]==='\n') {
      const fence=/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(source.slice(index));
      if(fence) {
        const closing=new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*\\r?$`,'gm');
        closing.lastIndex=index+fence[0].length;
        const match=closing.exec(source);
        end=match ? match.index+match[0].length : source.length;
      }
    }
    if(end===undefined && source[index]==='`') {
      const ticks=/^`+/.exec(source.slice(index))![0];
      const closing=new RegExp('(?<!`)`{'+ticks.length+'}(?!`)','g');
      closing.lastIndex=index+ticks.length;
      const match=closing.exec(source);
      if(match) end=match.index+match[0].length;
      else {index+=ticks.length;continue;}
    }
    if(end!==undefined) {
      output.push(normalizeText(source.slice(plainStart,index)),source.slice(index,end));
      index=end;plainStart=end;
    } else index+=source[index]==='\\' ? Math.min(2,source.length-index) : 1;
  }
  output.push(normalizeText(source.slice(plainStart)));
  return output.join('');
}
