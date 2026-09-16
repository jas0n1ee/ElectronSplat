export type JobState='waiting'|'running'|'completed'|'failed'|'cancelled';
export type ConversionJob<T>={id:string;name:string;payload?:T;state:JobState;progress:number;stage:string;detail:string;error?:string;cancellable:boolean};

/** A job owns the converter until its disk commit or abort has fully settled. */
export class ConversionQueue<T> {
  readonly jobs:ConversionJob<T>[]=[];
  active:ConversionJob<T>|undefined;
  private controller:AbortController|undefined;
  constructor(private readonly execute:(job:ConversionJob<T>,signal:AbortSignal)=>Promise<void>,private readonly changed:()=>void){}
  get pending(){return this.jobs.filter(job=>job.state==='waiting'||job.state==='running').length;}
  enqueue(id:string,name:string,payload:T){
    const job:ConversionJob<T>={id,name,payload,state:'waiting',progress:0,stage:'等待转换',detail:'',cancellable:true};
    this.jobs.push(job);this.pump();this.changed();return job;
  }
  update(job:ConversionJob<T>,stage:string,detail:string,fraction?:number){
    if(job.state!=='running')return;
    job.stage=stage;job.detail=detail;
    if(fraction!==undefined&&Number.isFinite(fraction))job.progress=Math.max(job.progress,Math.min(.99,Math.max(0,fraction)));
    this.changed();
  }
  cancel(id:string){
    const job=this.jobs.find(job=>job.id===id);
    if(!job||!job.cancellable)return;
    if(job.state==='waiting'){job.state='cancelled';job.stage='已移除';job.payload=undefined;this.changed();}
    else if(job===this.active){job.cancellable=false;this.controller?.abort();this.changed();}
  }
  private pump(){
    if(this.active)return;
    const job=this.jobs.find(job=>job.state==='waiting');if(!job)return;
    this.active=job;job.state='running';this.controller=new AbortController();
    const signal=this.controller.signal;
    void Promise.resolve().then(()=>this.execute(job,signal)).then(()=>{
      job.state='completed';job.progress=1;job.stage='已完成';job.detail='已保存到 scenes';
    },error=>{
      job.state=signal.aborted?'cancelled':'failed';job.stage=signal.aborted?'已取消':'转换失败';
      job.error=error instanceof Error?error.message:String(error);
    }).finally(()=>{
      job.payload=undefined;job.cancellable=false;this.active=undefined;this.controller=undefined;
      this.pump();this.changed();
    });
  }
}
