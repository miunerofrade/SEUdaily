export type BackendIdentity = {name:string; protocol:number; version:string; dataRoot:string; processId?:number; persistent?:boolean; managed?:boolean; web?:boolean; serviceManager?:string; serviceUnit?:string};
type Update = {version:{current:string;latest:string;available:boolean};install?:() => Promise<void>;rollback?:()=>Promise<void>;finalize?:()=>Promise<void>};
type Hooks = {
  probe:() => Promise<BackendIdentity|undefined>;
  stop:(identity:BackendIdentity) => Promise<void>;
  start:(identity:BackendIdentity, version:string) => Promise<void>;
  healthy:() => Promise<void>;
  cleanup:(version:string) => Promise<void>;
  wait?:() => Promise<void>;
};
/** Update only the selected data directory; commit cleanup after replacement readiness. */
export async function completeUpdate(update:Update, dataRoot:string, protocol:number, hooks:Hooks) {
  if (!update.install) return false;
  const previous = await hooks.probe();
  if (previous && (previous.name !== 'SEUdaily' || previous.protocol !== protocol || previous.dataRoot !== dataRoot))
    throw new Error('端口上的后端不属于当前 SEUdaily 数据目录，未执行更新');
  let stopped = false;
  try {
    if (previous) {
      await hooks.stop(previous);
      stopped = true;
      for (let attempt=0; ; attempt++) {
        if (!await hooks.probe()) break;
        if (attempt>=99) throw new Error('后端仍在停止，未安装新版本');
        await hooks.wait?.();
      }
    }
    await update.install();
    if (previous) {
      await hooks.start(previous,update.version.latest);
      const identity = await hooks.probe();
      if (!identity || identity.name !== 'SEUdaily' || identity.protocol !== protocol || identity.dataRoot !== dataRoot || identity.version !== update.version.latest)
        throw new Error('更新后的后端版本或数据目录不匹配');
      await hooks.healthy();
    }
  } catch (error) {
    if (previous && stopped) {
      try {
        const current = await hooks.probe();
        if (current) {
          if (current.name !== 'SEUdaily' || current.protocol !== protocol || current.dataRoot !== dataRoot) throw new Error('端口已被其它服务占用');
          await hooks.stop(current);
          for (let attempt=0;await hooks.probe();attempt++) {
            if (attempt>=99) throw new Error('新后端尚未停止');
            await hooks.wait?.();
          }
        }
        await update.rollback?.();
        await hooks.start(previous,update.version.current);
        await hooks.healthy();
      } catch (restore) { throw new Error(`更新失败：${(error as Error).message}；后端恢复失败：${(restore as Error).message}`); }
    } else await update.rollback?.();
    throw error;
  }
  await update.finalize?.();
  await hooks.cleanup(update.version.latest);
  return true;
}
