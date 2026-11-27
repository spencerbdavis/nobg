import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: "https://nobg.here", changeFrequency: "weekly", priority: 1 },
    { url: "https://nobg.here/developers", changeFrequency: "monthly", priority: 0.6 },
  ];
}
