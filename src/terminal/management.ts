import { randomUUID } from 'node:crypto';
import type { Session } from './session.js';
export type Field = { key: string; label: string; value: string; secret?: boolean; multiline?: boolean; choices?: Array<{value:string;label:string}> };
export type Form = { title: string; fields: Field[]; saveLabel?: string; save: (values: Record<string,string>) => Promise<void> };
const field=(key:string,label:string,value:unknown=''):Field=>({key,label,value:String(value ?? '')});
const integer=(value:string,min:number,max:number)=>{const n=Number(value);if(!Number.isInteger(n)||n<min||n>max)throw new Error(`请输入 ${min}–${max} 的整数`);return n;};
export { diskSize } from '../shared/disk-size.js';
import { diskSize } from '../shared/disk-size.js';
export async function settingsForm(s:Session):Promise<Form> {
 const data=await s.client.json('/app/settings');
 return {title:'设置 · 空白密钥保持原值',fields:[...data.fields.map((f:any)=>({...field(f.name,f.name+(f.configured?' · 已配置':''),f.value),secret:f.secret})),{...field('agentInstructions','AGENT.md',data.agentInstructions),multiline:true}],save:async values=>{
 const {agentInstructions,...env}=values;
 const result=await s.client.json('/app/settings','POST',{values:env,agentInstructions});
 s.show(result.restartRequired?'设置已保存；环境变量在服务重启后生效。':'设置已保存；下一轮对话生效。');
 }};
}
export function semesterForm(s:Session):Form {
 const semester=s.schedule.customizations?.semester ?? {};
 return {title:'学期设置',fields:[field('name','学期名称',semester.name),field('startDate','起始日期 YYYY-MM-DD',semester.startDate),field('totalWeeks','总周数',semester.totalWeeks || 20)],save:async v=>{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(v.startDate)||new Date(v.startDate).toISOString().slice(0,10)!==v.startDate)throw new Error('起始日期无效');
 const next=structuredClone(s.schedule.customizations);next.semester={name:v.name,startDate:v.startDate,totalWeeks:integer(v.totalWeeks,1,30)};
 s.result(await s.client.json('/app/schedule','PUT',next));await s.loadSchedule();
 }};
}
export function courseForm(s:Session,course?:any,single=false):Form {
 return {title:course?'编辑课程':'添加课程',fields:[field('courseName','课程名',course?.courseName),field('teacherName','教师',course?.teacherName),field('classroom','地点',course?.classroom),field('weekday','星期 1–7',course?.weekday || 1),field('startPeriod','开始节次',course?.startPeriod || 1),field('endPeriod','结束节次',course?.endPeriod || 2),field('weeks','周次（如 1-16 或 1,3,5）',course?.weeks?.join(',') || `1-${s.schedule.customizations?.semester?.totalWeeks || 20}`),field('date','单日日期（留空为周期课程）',course?.occurrenceDate || (single?new Date().toLocaleDateString('sv-SE'):''))],save:async v=>{
 if(!v.courseName.trim())throw new Error('请填写课程名');
 const start=integer(v.startPeriod,1,13),end=integer(v.endPeriod,start,13);
 const weeks=[...new Set(v.weeks.split(/[,，\s]+/).filter(Boolean).flatMap(item=>{const [a,b]=item.split('-');const from=integer(a,1,30),to=b?integer(b,from,30):from;return Array.from({length:to-from+1},(_,i)=>from+i);}))].sort((a,b)=>a-b);
 const base={courseName:v.courseName.trim(),teacherName:v.teacherName.trim(),classroom:v.classroom.trim(),weekday:integer(v.weekday,1,7),startPeriod:start,endPeriod:end,weeklyPeriods:Array.from({length:end-start+1},(_,i)=>start+i),weeks,courseCode:course?.courseCode || '',sourceKey:course?.sourceKey || '',scheduleId:course?.scheduleId || ''};
 if(v.date && (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)||new Date(v.date).toISOString().slice(0,10)!==v.date))throw new Error('单日日期无效');
 const next=structuredClone(s.schedule.customizations);
 if(course?.source==='remote')next.overrides[course.sourceKey]={...next.overrides[course.sourceKey],...base};
 else if(course?.customId && next.customCourses.some((c:any)=>c.customId===course.customId))next.customCourses=next.customCourses.map((c:any)=>c.customId===course.customId?{...c,...base}:c);
 else if(course?.customId)next.dateOverrides=next.dateOverrides.map((c:any)=>c.id===course.customId?{...c,date:v.date||c.date,course:{...c.course,...base}}:c);
 else if(v.date){const id=randomUUID();next.dateOverrides.push({id,date:v.date,action:'add',course:{...base,customId:id}});}
 else {const id=randomUUID();next.customCourses.push({...base,customId:id,scheduleId:`custom-${id}`,sourceKey:`custom-${id}`,source:'custom'});}
 s.result(await s.client.json('/app/schedule','PUT',next));await s.loadSchedule();
 }};
}
export function programStatusForm(s:Session,planId:string,course:any):Form {
 const semesters=course.semesterOptions?.length?course.semesterOptions:[{value:course.semester || 'unassigned',label:course.semesterLabel || '未安排学期'}];
 const current=semesters.find((option:any)=>option.value===course.semester) ?? semesters[0];
 return {title:`修读状态 · ${course.name}`,fields:[{...field('semester','学期',current.value),choices:semesters.map((o:any)=>({value:o.value,label:o.label}))},{...field('status','状态',course.manualStatus ? course.status : 'auto'),choices:[{value:'auto',label:'自动判断'},{value:'completed',label:'已完成'},{value:'studying',label:'学习中'},{value:'not_taken',label:'未修读'}]}],save:async v=>{s.result(await s.client.json('/app/programs/course-status','PATCH',{planId,courseId:course.id || course.code || course.name,semester:v.semester,status:v.status}));await s.loadPrograms();}};
}
export function focusForm(s:Session,item?:any):Form {
 return {title:item?'编辑关注':'添加关注 · 创建即授权完全访问，不含 extra',fields:[field('title','名称',item?.title),{...field('kind','类型',item?.kind || 'notice'),choices:[{value:'notice',label:'通知'},{value:'course',label:'课程'}]},field('description','任务说明',item?.description),{...field('enabled','启用',String(item?.enabled ?? true)),choices:[{value:'true',label:'启用'},{value:'false',label:'暂停'}]}],save:async v=>{if(!v.title.trim()||!v.description.trim())throw new Error('请填写名称及任务说明');const saved=s.result(await s.client.json('/app/focus','POST',{...item,...v,title:v.title.trim(),description:v.description.trim(),enabled:v.enabled==='true'}));await s.loadFocus();if(!item && v.enabled==='true'){if(!saved.data?.item)throw new Error('关注已保存，但服务端没有返回会话信息');await s.runCreatedFocus(saved.data.item);}}};
}
