/** Work-weighted estimate for one whole scene. No timer-driven progress. */
export class ConversionProgress {
  value=0;
  constructor(private readonly inputBytes:readonly number[]) {}
  advance(value:number){
    if(Number.isFinite(value))this.value=Math.max(this.value,Math.min(.97,Math.max(0,value)));
    return this.value;
  }
  input(index:number,boundsFraction:number,processedFraction:number){
    const clamp=(n:number)=>Math.min(1,Math.max(0,n));
    const total=this.inputBytes.reduce((a,b)=>a+b,0);
    const before=this.inputBytes.slice(0,index).reduce((a,b)=>a+b,0);
    return this.advance(.02+.53*(before+this.inputBytes[index]*(.15*clamp(boundsFraction)+.85*clamp(processedFraction)))/total);
  }
  partition(fraction:number){return this.advance(.55+.03*Math.min(1,Math.max(0,fraction)));}
  errors(fraction:number){return this.advance(.58+.06*Math.min(1,Math.max(0,fraction)));}
  encoded(completed:number,total:number){
    if(total>0)return this.advance(.64+.22*Math.min(1,Math.max(0,completed/total)));
    return this.value;
  }
  encodedAll(){return this.advance(.86);}
  voxel(fraction:number){return this.advance(.86+.10*Math.min(1,Math.max(0,fraction)));}
  workerComplete(){return this.advance(.97);}
}
