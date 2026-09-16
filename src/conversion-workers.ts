import { WorkerQueue } from '@playcanvas/splat-transform';

declare const __CPU_WORKER_URL__:string;
export function configureWorkers(report:(event:string,data:unknown)=>void) {
  const NativeWorker=self.Worker;
  let spawned=0,ready=0,active=0,peak=0,completed=0;
  const tasks:Record<string,number>={};
  // Observe the official worker protocol without changing its scheduling or tasks.
  self.Worker=class extends NativeWorker {
    private task='';
    constructor(url:string|URL,options?:WorkerOptions) {
      super(url,options);spawned++;
      this.addEventListener('message',e=>{
        if(e.data.type==='ready'){ready++;report('conversion.worker.ready',{spawned,ready});}
        else if(this.task){active--;completed++;tasks[this.task]=(tasks[this.task]??0)+1;this.task='';}
      });
      this.addEventListener('error',e=>report('conversion.worker.error',{message:e.message}));
    }
    override postMessage(message:any,transfer:Transferable[]|StructuredSerializeOptions=[]) {
      if(message.type==='run'){this.task=message.task;active++;peak=Math.max(peak,active);}
      if(Array.isArray(transfer))super.postMessage(message,transfer);else super.postMessage(message,transfer);
    }
  };
  WorkerQueue.workerUrl=__CPU_WORKER_URL__;
  WorkerQueue.maxWorkers=null;
  report('conversion.workers.config',{mode:'official-auto',cores:navigator.hardwareConcurrency,max:Math.max(1,Math.min(4,(navigator.hardwareConcurrency||2)-1))});
  return ()=>({spawned,ready,peak,completed,tasks,inline:WorkerQueue.isInline});
}
