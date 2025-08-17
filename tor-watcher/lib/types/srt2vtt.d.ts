declare module "srt2vtt" {
  import { Transform } from "stream";
  export default function srt2vtt(): Transform;
}