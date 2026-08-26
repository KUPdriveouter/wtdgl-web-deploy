# WTDGL Web Deployment

Generated WebGL deployment artifacts for the public WTDGL web player. Game source code remains in the private development repository.

The compressed Unity data file is stored as numbered parts to remain below GitHub's per-file limit. The Docker build concatenates those parts back into `WebGLSmoke.data.gz` before publishing the image.
