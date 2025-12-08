import type { TorrentSearchResponse } from "@/lib/types";

export const torrentDataToList = (data: TorrentSearchResponse[]) => {
  return data.map((item) => {
    return {
      title: item.title,
      link: item.magnetUrl
    }
  })
};