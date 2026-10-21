import {useEffect,useState} from 'react';
import {durationLabel,elapsedTime,type RunTiming} from '../../../../src/shared/timing';

export function Elapsed({timing,prefix=''}:{timing?:RunTiming;prefix?:string}) {
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{
    setNow(Date.now());
    if (timing?.startedAt===undefined) return;
    const timer=window.setInterval(()=>setNow(Date.now()),1000);
    return ()=>clearInterval(timer);
  },[timing?.startedAt]);
  if (!timing) return null;
  return <span className="elapsed-time">{prefix}{durationLabel(elapsedTime(timing,now))}</span>;
}
