import {useEffect,useState} from 'react';
import {durationLabel,elapsedTime,type RunTiming} from '../../../../src/shared/timing';

export function Elapsed({timing,prefix='',secondsOnly=false}:{timing?:RunTiming;prefix?:string;secondsOnly?:boolean}) {
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{
    setNow(Date.now());
    if (timing?.startedAt===undefined) return;
    const timer=window.setInterval(()=>setNow(Date.now()),1000);
    return ()=>clearInterval(timer);
  },[timing?.startedAt]);
  if (!timing) return null;
  const elapsed=elapsedTime(timing,now);
  return <span className={`elapsed-time${secondsOnly ? ' thought-duration' : ''}`}>{prefix}{secondsOnly ? `${Math.floor(elapsed/1000)} 秒` : durationLabel(elapsed)}</span>;
}
