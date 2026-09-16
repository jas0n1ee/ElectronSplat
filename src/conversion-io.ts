import { MemoryFileSystem, ReadStream, type FileSystem, type ReadFileSystem, type Writer } from '@playcanvas/splat-transform';
import { safePath } from './manifest';

/** Adapt official output to acknowledged desktop writes, retaining only the current file. */
export class OutputFileSystem implements FileSystem {
  constructor(private persist:(path:string,bytes:Uint8Array)=>Promise<void>) {}
  async mkdir(_path:string) {}
  createWriter(filename:string):Writer {
    const path=safePath(filename.replace(/^\//,'')), memory=new MemoryFileSystem(), writer=memory.createWriter(path);
    return {
      get bytesWritten(){return writer.bytesWritten;},
      write(data){
        if(writer.bytesWritten+data.byteLength>128*1024**2)throw new Error(`输出文件超过 128 MiB：${path}`);
        return writer.write(data);
      },
      close:async()=>{
        await writer.close();
        try {await this.persist(path,memory.results.get(path)!);} finally {memory.results.clear();}
      },
      abort:()=>writer.abort()
    };
  }
}

/** Shared bounded cache for the official reader's small, repeated gather ranges. */
export class WorkFileSystem implements ReadFileSystem {
  readonly files=new Map<string,number>();
  private cache=new Map<string,Uint8Array>();
  private cachedBytes=0;
  constructor(private readRange:(path:string,start:number,end:number)=>Promise<ArrayBuffer>,private cacheLimit=32*1024**2) {}
  clear(){this.cache.clear();this.cachedBytes=0;}
  private async range(path:string,start:number,end:number):Promise<Uint8Array> {
    const size=this.files.get(path)!;
    if(size>Math.min(this.cacheLimit,8*1024**2))return new Uint8Array(await this.readRange(path,start,end));
    let bytes=this.cache.get(path);
    if(bytes)this.cache.delete(path);
    else {
      bytes=new Uint8Array(await this.readRange(path,0,size));
      if(bytes.length!==size)throw new Error('临时文件读取不完整。');
      while(this.cachedBytes+size>this.cacheLimit&&this.cache.size){
        const [old,data]=this.cache.entries().next().value!;this.cache.delete(old);this.cachedBytes-=data.length;
      }
      this.cachedBytes+=size;
    }
    this.cache.set(path,bytes);return bytes.subarray(start,end);
  }
  async createSource(filename:string) {
    const path=safePath(filename),size=this.files.get(path);
    if(size===undefined)throw new Error('未登记的临时 PLY。');
    const range=this.range.bind(this);
    return {size,seekable:true,close(){},read(start=0,end=size){
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>size)throw new Error('临时 PLY 读取范围无效。');
      return new class extends ReadStream {
        private position=start;
        constructor(){super(end-start);}
        async pull(target:Uint8Array){
          const length=Math.min(target.length,end-this.position,8*1024**2);
          if(!length)return 0;
          const bytes=await range(path,this.position,this.position+length);
          if(bytes.length!==length)throw new Error('临时 PLY 读取不完整。');
          target.set(bytes);this.position+=length;this.bytesRead+=length;return length;
        }
        close(){this.position=end;}
      }();
    }};
  }
}
