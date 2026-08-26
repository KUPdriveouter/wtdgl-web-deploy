# WTDGL Web Deployment

Lightweight container host for the public WTDGL web player. Game source code and generated WebGL binaries remain outside this Git repository.

Publishing a temporary `wtdgl-webgl.zip` GitHub Release asset triggers the container workflow. It downloads the archive into `public/`, publishes `ghcr.io/kupdriveouter/wtdgl-web-deploy:railway`, then deletes the temporary release and tag. Generated WebGL files must never be committed here.
