/**
 * Work-weighted estimate for one whole scene. No timer-driven progress.
 *
 * The band widths come from measured conversions rather than from guesswork. A 41.8M-point capture
 * on a discrete GPU and a 6.8M-point one on integrated graphics agreed on the ordering and roughly
 * on the shape -- read+decimate ~33%/20%, partition ~25%/17%, SOG encode ~39%/42% -- and disagreed
 * on the voxel pass, 2.4% against 21%. That gap is the GPU, not the input, so the width here is a
 * compromise; the bar is an estimate and is not meant to be read as a clock.
 *
 * The previous widths put partition at 3% while it took a quarter of the wall clock, which is what
 * made the bar look stuck for minutes at a time.
 */
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
    return this.advance(.02+.30*(before+this.inputBytes[index]*(.15*clamp(boundsFraction)+.85*clamp(processedFraction)))/total);
  }
  partition(fraction:number){return this.advance(.32+.20*Math.min(1,Math.max(0,fraction)));}
  errors(fraction:number){return this.advance(.52+.03*Math.min(1,Math.max(0,fraction)));}
  encoded(completed:number,total:number){
    if(total>0)return this.advance(.55+.34*Math.min(1,Math.max(0,completed/total)));
    return this.value;
  }
  encodedAll(){return this.advance(.89);}
  voxel(fraction:number){return this.advance(.89+.07*Math.min(1,Math.max(0,fraction)));}
  /** Map a converter phase plus its own 0..1 fraction onto the whole-scene estimate. */
  byPhase(phase:string,fraction:number){
    const f=Number.isFinite(fraction)?Math.min(1,Math.max(0,fraction)):0;
    switch(phase){
      case 'partition':return this.partition(f);
      case 'errors':return this.errors(f);
      // encoded() divides by total; a ratio already is the quotient, so pass it as c/1.
      case 'encode':return this.encoded(f,1);
      case 'voxel':return this.voxel(f);
      // Reading and decimation share the input band; the converter reports them as one phase.
      default:return this.advance(.02+.30*f);
    }
  }
  workerComplete(){return this.advance(.97);}
}
