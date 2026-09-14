# Retired code

`render_3d_retired/` is the original Three.js renderer from before AQUAPIX moved
to the 2D pixel-art presentation. Nothing in `src/` imports it, and `three` is no
longer a dependency, so these files will not resolve their imports as-is.

It is kept for reference only and is deliberately outside `src/` so it can never
be pulled into a production build.
