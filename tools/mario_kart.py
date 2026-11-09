# mario_kart.py — model a cartoon (Mario-style) go-kart and export a GLB that satisfies the
# kartclash contract: nodes Kart_wheels_front / Kart_wheels_back (one indexed mesh per axle,
# wheels split left/right by x sign), node Kart_seat (driver seating box), materials
# 'Green paint' (repainted per racer), 'Steel' (repainted with the trim colour), 'Dark iron'
# and 'Rubber' (keep their colours), plus a light rim colour. Nose faces Blender +Z.
import bpy, math

def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras):
        for d in list(coll):
            if d.users == 0:
                coll.remove(d)

def mat(name, rgba, metallic=0.0, rough=0.5):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgba, 1)
    if 'Metallic' in bsdf.inputs: bsdf.inputs['Metallic'].default_value = metallic
    if 'Roughness' in bsdf.inputs: bsdf.inputs['Roughness'].default_value = rough
    return m

groups = {}
def add(obj, group):
    groups.setdefault(group, []).append(obj)

clear_scene()
M_PAINT = mat('Green paint', (0.75, 0.05, 0.05), 0.1, 0.35)
M_STEEL = mat('Steel', (0.75, 0.75, 0.78), 0.9, 0.25)
M_DARK  = mat('Dark iron', (0.05, 0.05, 0.06), 0.8, 0.45)
M_RUBB  = mat('Rubber', (0.02, 0.02, 0.02), 0.0, 0.9)
M_RIM   = mat('White rim', (0.85, 0.85, 0.82), 0.3, 0.4)

def sphere(name, loc, scale, material, seg=32, ring=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=ring, location=loc)
    o = bpy.context.active_object; o.name = name; o.scale = scale
    o.data.materials.append(material); return o

def cylinder(name, loc, scale, material, rot=(0,0,0), verts=32):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, location=loc, rotation=rot)
    o = bpy.context.active_object; o.name = name; o.scale = scale
    o.data.materials.append(material); return o

def torus(name, loc, R, r, material, rot=(0,0,0), mj=28, mn=14):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=mj, minor_segments=mn, location=loc, rotation=rot)
    o = bpy.context.active_object; o.name = name; o.data.materials.append(material); return o

def box(name, loc, dims, material):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.active_object; o.name = name; o.scale = (dims[0]/2, dims[1]/2, dims[2]/2)
    o.data.materials.append(material); return o

def smooth(o):
    try:
        bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
        bpy.ops.object.shade_auto_smooth(angle=math.radians(40))
    except Exception:
        bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
        bpy.ops.object.shade_smooth()

def bevel(o, width=0.02):
    m = o.modifiers.new('bev', 'BEVEL'); m.width = width; m.segments = 2

# ---------------- body pod (repainted) : rounded tub + nose cone + seat back ----------------
pod  = sphere('body_pod',  (0, 0.36, -0.05), (0.50, 0.32, 0.78), M_PAINT)
nose = sphere('nose_cone', (0, 0.34, 0.85), (0.40, 0.28, 0.34), M_PAINT)
hump = sphere('seat_hump', (0, 0.40, -0.72), (0.34, 0.24, 0.34), M_PAINT)
for p in (pod, nose, hump): smooth(p)
add(pod, 'paint'); add(nose, 'paint'); add(hump, 'paint')

# ---------------- front bumper ring: the kart's defining cartoon feature ----------------
bumper = torus('bumper', (0, 0.30, 0.98), 0.52, 0.115, M_STEEL, rot=(math.radians(90), 0, 0))
smooth(bumper); add(bumper, 'steel')
# number plate: disc on the nose
plate = cylinder('plate', (0, 0.42, 1.13), (0.22, 0.22, 0.02), M_STEEL, rot=(math.radians(90), 0, 0))
smooth(plate); add(plate, 'steel')
# twin exhausts at the back
for s in (-1, 1):
    ex = cylinder('exhaust', (s*0.30, 0.36, -1.12), (0.07, 0.07, 0.21), M_STEEL, rot=(math.radians(90), 0, 0))
    smooth(ex); add(ex, 'steel')

# ---------------- chassis + steering wheel (dark) ----------------
chassis = box('chassis', (0, 0.18, 0), (0.72, 0.14, 1.85), M_DARK); bevel(chassis, 0.03); add(chassis, 'dark')
col = cylinder('steer_col', (0, 0.50, 0.52), (0.035, 0.035, 0.21), M_DARK, rot=(math.radians(70), 0, 0)); add(col, 'dark')
rim = torus('steer_rim', (0, 0.58, 0.72), 0.20, 0.03, M_DARK, rot=(math.radians(70), 0, 0), mj=20, mn=8); smooth(rim); add(rim, 'dark')
# exhaust heat shields / small fins for silhouette
fin = box('fin', (0, 0.55, -1.02), (0.66, 0.05, 0.16), M_DARK); bevel(fin, 0.02); add(fin, 'dark')

# ---------------- seat (named node; the game seats the driver from this box) ----------------
seat  = box('seat', (0, 0.36, -0.42), (0.46, 0.10, 0.44), M_DARK); bevel(seat, 0.03)
backr = box('seatback', (0, 0.62, -0.62), (0.44, 0.34, 0.10), M_DARK); bevel(backr, 0.03)
add(seat, 'seat')

# ---------------- wheels: fat cartoon tyres with big light rims ----------------
def wheel(side_z, z):
    parts = []
    for x in (-0.72, 0.72):
        tyre = cylinder(f'tyre', (x, 0.31, z), (0.31, 0.31, 0.13), M_RUBB, rot=(0, math.radians(90), 0))
        rimc = cylinder(f'rim', (x, 0.31, z), (0.20, 0.20, 0.145), M_RIM, rot=(0, math.radians(90), 0))
        hub  = cylinder(f'hub', (x, 0.31, z), (0.06, 0.06, 0.17), M_STEEL, rot=(0, math.radians(90), 0))
        for p in (tyre, rimc, hub):
            try:
                bpy.ops.object.select_all(action='DESELECT'); p.select_set(True); bpy.context.view_layer.objects.active = p
                bpy.ops.object.shade_auto_smooth(angle=math.radians(35))
            except Exception: pass
        parts += [tyre, rimc, hub]
    return parts

front_parts = wheel('front', 0.62)
back_parts  = wheel('back', -0.62)

# join each material group into ONE mesh; wheels join per axle (contract: one mesh per axle)
def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    out = bpy.context.active_object; out.name = name
    return out

# CRITICAL: bake all object transforms into mesh data before joining. With unapplied
# scale/rotation, Blender's join leaves the active object's TRS on the merged mesh and
# the GLB node inherits it — the kart exported broken (garbage bounding boxes, 2026-11-09).
bpy.ops.object.select_all(action='DESELECT')
groups['paint'].append(backr)   # backrest belongs to the body (seat group top = driver seat height)
_meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for o in _meshes: o.select_set(True)
bpy.context.view_layer.objects.active = _meshes[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

paint_o = join(groups['paint'], 'Kart_body')
steel_o = join(groups['steel'], 'Kart_trim')
dark_o  = join(groups['dark'],  'Kart_chassis')
seat_o  = join([groups['seat'][0]], 'Kart_seat')
front_o = join(front_parts, 'Kart_wheels_front')
back_o  = join(back_parts,  'Kart_wheels_back')

bpy.ops.object.select_all(action='DESELECT')
bpy.ops.export_scene.gltf(filepath='/tmp/mario-kart.glb', export_format='GLB', export_apply=True, export_yup=False)
print('EXPORTED /tmp/mario-kart.glb')
for o in bpy.data.objects:
    if o.type == 'MESH':
        bb = [o.matrix_world @ __import__('mathutils').Vector(c) for c in o.bound_box]
        xs=[v.x for v in bb]; ys=[v.y for v in bb]; zs2=[v.z for v in bb]
        print(o.name, 'mats', [m.name if m else None for m in o.data.materials],
              'x', round(min(xs),2), round(max(xs),2), 'y', round(min(ys),2), round(max(ys),2), 'z', round(min(zs2),2), round(max(zs2),2))
