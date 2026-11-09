import path from 'node:path';

// Only these formats are indexed. Audio/video preview depends on browser codecs.
const types = new Map();
function add(extensions, resourceType, preview, mime = 'application/octet-stream') {
  for (const extension of extensions.split(' ')) {
    types.set(`.${extension}`, Object.freeze({ resourceType, preview, mime }));
  }
}
add('pdf', '资料文档', 'pdf', 'application/pdf');
add('epub', '电子书', 'epub', 'application/epub+zip');
add('mobi azw azw3 cbz djvu', '电子书', null);
add('txt md markdown log ini conf tex bib ris', '资料文档', 'text', 'text/plain; charset=utf-8');
add('csv tsv json jsonl xml yaml yml', '数据集', 'text', 'text/plain; charset=utf-8');
// HTML, SVG and source code are never served as executable documents.
add('html htm css js ts py sql sh', '其他', 'text', 'text/plain; charset=utf-8');
add('doc docx xls xlsx ppt pptx odt ods odp rtf caj nh kdh', '资料文档', null);
add('parquet h5 hdf5 sqlite db sav dta mat', '数据集', null);
add('jpg jpeg', '图片', 'image', 'image/jpeg');
add('png', '图片', 'image', 'image/png');
add('gif', '图片', 'image', 'image/gif');
add('webp', '图片', 'image', 'image/webp');
add('bmp', '图片', 'image', 'image/bmp');
add('avif', '图片', 'image', 'image/avif');
add('heic tif tiff', '图片', null);
add('svg', '图片', 'text', 'text/plain; charset=utf-8');
add('mp3', '音频', 'audio', 'audio/mpeg');
add('wav', '音频', 'audio', 'audio/wav');
add('ogg', '音频', 'audio', 'audio/ogg');
add('flac', '音频', 'audio', 'audio/flac');
add('m4a', '音频', 'audio', 'audio/mp4');
add('aac', '音频', 'audio', 'audio/aac');
add('mp4 m4v', '视频', 'video', 'video/mp4');
add('webm', '视频', 'video', 'video/webm');
add('mov', '视频', 'video', 'video/quicktime');
add('mkv', '视频', 'video', 'video/x-matroska');
add('avi', '视频', 'video', 'video/x-msvideo');
add('zip rar 7z tar gz', '其他', null);

export const supportedExtensions = Object.freeze([...types.keys()]);
export function fileType(filename) {
  return types.get(path.posix.extname(filename).toLowerCase()) || null;
}
