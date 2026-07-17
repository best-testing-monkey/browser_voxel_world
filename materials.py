"""Material catalog for the voxel world.

Builds a list of 1024+ materials. Material id 0 is reserved for air.
Each material is a dict: {"id": int, "name": str, "category": str, "color": "#rrggbb"}.

Sources of names, in order:
  - Minecraft block palette (including 16-color dyed families)
  - Modern building & construction materials
  - Crafting / workshop materials
  - The full periodic table of elements
  - Rocks, minerals and gemstones
  - Wood species
  - Metals and alloys
  - Textiles and fabrics
  - Plastics and polymers
  - Historical / vernacular building materials
  - Generated stone finishes and paint swatches to pad past 1024
"""

import colorsys
import hashlib
import re
from pathlib import Path

MINIMUM_MATERIALS = 1024
OBJECTS_DIR = Path(__file__).parent / "objects"
OBJECT_UNIT_MM = 10  # 1 local unit in an objects/*.txt file = 10 mm

# ---------------------------------------------------------------------------
# Explicit colors for well-known materials (name -> hex). Anything not listed
# here gets a deterministic color derived from its name.
# ---------------------------------------------------------------------------
KNOWN_COLORS = {
    "Granite": "#9e7a68",
    "Polished Granite": "#a87d6e",
    "Polished Andesite": "#9b9d9a",
    "Polished Diorite": "#c5c5c7",
    "Stone": "#7d7d7d",
    "Cobblestone": "#797979",
    "Dirt": "#866043",
    "Grass Block": "#5d923a",
    "Sand": "#dbd3a0",
    "Red Sand": "#a95821",
    "Gravel": "#84807f",
    "Oak Planks": "#a2814d",
    "Oak Log": "#6d5636",
    "Bedrock": "#565656",
    "Water": "#3f61d0",
    "Lava": "#d45a12",
    "Coal Ore": "#373737",
    "Iron Ore": "#af8e77",
    "Gold Ore": "#c1a940",
    "Diamond Ore": "#5decf5",
    "Emerald Ore": "#17c544",
    "Lapis Lazuli Ore": "#1d47a5",
    "Redstone Ore": "#a00000",
    "Obsidian": "#14121e",
    "Glass": "#c9e8e5",
    "Glowstone": "#f9d49c",
    "Netherrack": "#723a38",
    "Soul Sand": "#554034",
    "End Stone": "#dbde9e",
    "Prismarine": "#63ab95",
    "Sea Lantern": "#ace5d5",
    "Ice": "#7dadff",
    "Packed Ice": "#8db4fa",
    "Blue Ice": "#74a8fd",
    "Snow Block": "#f0fbfb",
    "Clay Block": "#a0a6b3",
    "Brick Block": "#96594b",
    "Bookshelf": "#6b5839",
    "Mossy Cobblestone": "#68765f",
    "Sponge": "#c3c14d",
    "Wet Sponge": "#a8a03a",
    "Pumpkin": "#c57618",
    "Melon": "#8fa834",
    "Hay Bale": "#ab8b26",
    "Slime Block": "#6fc05b",
    "Honey Block": "#fbb934",
    "Honeycomb Block": "#e5941d",
    "Diorite": "#bcbcbc",
    "Andesite": "#888a87",
    "Deepslate": "#4c4c50",
    "Tuff": "#6d6e68",
    "Calcite": "#dfe0dc",
    "Dripstone Block": "#866b5c",
    "Amethyst Block": "#8562c6",
    "Copper Block": "#c06c50",
    "Iron Block": "#dcdcdc",
    "Gold Block": "#f6d33c",
    "Diamond Block": "#65eddc",
    "Emerald Block": "#2bc253",
    "Lapis Lazuli Block": "#274fb4",
    "Redstone Block": "#ab1a09",
    "Coal Block": "#101010",
    "Netherite Block": "#443f41",
    "Quartz Block": "#ebe6df",
    "Basalt": "#4e4e56",
    "Blackstone": "#2a252c",
    "Crying Obsidian": "#2c0a54",
    "Magma Block": "#8e3f20",
    "Shroomlight": "#f29746",
    "Warped Nylium": "#2c7365",
    "Crimson Nylium": "#832020",
    "Mycelium": "#6f6265",
    "Podzol": "#59381d",
    "Mud": "#3c3a3d",
    "Rooted Dirt": "#90674c",
    "Moss Block": "#596e2d",
    "Sculk": "#0d1e24",
    "TNT": "#af2d26",
    "Cactus": "#587b3a",
    "Sandstone": "#d8cb98",
    "Red Sandstone": "#a6531f",
    "Purpur Block": "#a97ba9",
    "Nether Bricks": "#2c161a",
    "Red Nether Bricks": "#460709",
    "Concrete": "#a8a8a0",
    "Reinforced Concrete": "#8f9089",
    "Asphalt": "#3a3a3c",
    "Tarmac": "#454547",
    "Plywood": "#c9a06a",
    "Marble": "#e8e4dc",
    "Slate": "#4a5259",
    "Limestone": "#cfc6a8",
    "Chalk": "#f4f1e6",
    "Flint": "#31343a",
    "Charcoal": "#2a2624",
    "Graphite": "#4b4d52",
    "Steel": "#a9adb2",
    "Stainless Steel": "#c4c9cd",
    "Aluminium": "#c8cbce",
    "Copper": "#b87333",
    "Brass": "#b5a642",
    "Bronze": "#cd7f32",
    "Tin": "#c4c7c9",
    "Lead": "#575c60",
    "Zinc": "#95989b",
    "Titanium": "#878a8d",
    "Gold": "#ffd700",
    "Silver": "#c0c0c0",
    "Platinum": "#e5e4e2",

    # Missing-materials pass: deepslate ore variants, deepslate/tuff
    # finishes, copper oxidation stages, mangrove roots.
    "Deepslate Coal Ore": "#333336",
    "Deepslate Iron Ore": "#8f8478",
    "Deepslate Copper Ore": "#7c6b58",
    "Deepslate Gold Ore": "#a89550",
    "Deepslate Redstone Ore": "#7a2020",
    "Deepslate Emerald Ore": "#2f6b48",
    "Deepslate Lapis Lazuli Ore": "#31447a",
    "Deepslate Diamond Ore": "#4bb0ab",
    "Chiseled Deepslate": "#3d3d40",
    "Cracked Deepslate Bricks": "#3a3a3d",
    "Cracked Deepslate Tiles": "#38383b",
    "Tuff Bricks": "#65665f",
    "Polished Tuff": "#6f7069",
    "Chiseled Tuff": "#6a6b64",
    "Cracked Tuff Bricks": "#5f605a",
    "Waxed Copper Block": "#c06c50",
    "Waxed Exposed Copper": "#af7a5e",
    "Waxed Weathered Copper": "#6f9377",
    "Waxed Oxidized Copper": "#4f9d80",
    "Exposed Cut Copper": "#ab7b60",
    "Weathered Cut Copper": "#6c9276",
    "Oxidized Cut Copper": "#4c9c7e",
    "Waxed Cut Copper": "#bd6f52",
    "Copper Bulb": "#c17552",
    "Exposed Copper Bulb": "#a97e63",
    "Weathered Copper Bulb": "#6e9074",
    "Oxidized Copper Bulb": "#4d9a7c",
    "Copper Grate": "#b96f52",
    "Exposed Copper Grate": "#a67c62",
    "Mangrove Roots": "#4c3524",
    "Muddy Mangrove Roots": "#5c4632",
}

DYE_COLORS = {
    "White": "#e9ecec", "Orange": "#f07613", "Magenta": "#bd44b3",
    "Light Blue": "#3aafd9", "Yellow": "#f8c527", "Lime": "#70b919",
    "Pink": "#ed8dac", "Gray": "#3e4447", "Light Gray": "#8e8e86",
    "Cyan": "#158991", "Purple": "#792aac", "Blue": "#35399d",
    "Brown": "#724728", "Green": "#546d1b", "Red": "#a12722",
    "Black": "#141519",
}

MINECRAFT_BASE = [
    "Stone", "Granite", "Polished Granite", "Diorite", "Polished Diorite",
    "Andesite", "Polished Andesite", "Deepslate", "Cobbled Deepslate",
    "Polished Deepslate", "Deepslate Bricks", "Deepslate Tiles", "Tuff",
    "Calcite", "Grass Block", "Dirt", "Coarse Dirt", "Podzol", "Rooted Dirt",
    "Mud", "Packed Mud", "Mud Bricks", "Mycelium", "Cobblestone",
    "Mossy Cobblestone", "Oak Planks", "Spruce Planks", "Birch Planks",
    "Jungle Planks", "Acacia Planks", "Dark Oak Planks", "Mangrove Planks",
    "Cherry Planks", "Bamboo Planks", "Crimson Planks", "Warped Planks",
    "Oak Log", "Spruce Log", "Birch Log", "Jungle Log", "Acacia Log",
    "Dark Oak Log", "Mangrove Log", "Cherry Log", "Bamboo Block",
    "Crimson Stem", "Warped Stem", "Oak Leaves", "Spruce Leaves",
    "Birch Leaves", "Jungle Leaves", "Acacia Leaves", "Dark Oak Leaves",
    "Mangrove Leaves", "Cherry Leaves", "Azalea Leaves", "Bedrock", "Sand",
    "Red Sand", "Gravel", "Sandstone", "Chiseled Sandstone", "Cut Sandstone",
    "Smooth Sandstone", "Red Sandstone", "Chiseled Red Sandstone",
    "Cut Red Sandstone", "Smooth Red Sandstone", "Coal Ore", "Iron Ore",
    "Copper Ore", "Gold Ore", "Redstone Ore", "Emerald Ore",
    "Lapis Lazuli Ore", "Diamond Ore", "Nether Gold Ore", "Nether Quartz Ore",
    "Ancient Debris", "Coal Block", "Iron Block", "Copper Block",
    "Exposed Copper", "Weathered Copper", "Oxidized Copper", "Cut Copper",
    "Gold Block", "Redstone Block", "Emerald Block", "Lapis Lazuli Block",
    "Diamond Block", "Netherite Block", "Amethyst Block", "Budding Amethyst",
    "Raw Iron Block", "Raw Copper Block", "Raw Gold Block", "Water", "Lava",
    "Ice", "Packed Ice", "Blue Ice", "Snow Block", "Powder Snow",
    "Clay Block", "Brick Block", "Bookshelf", "Chiseled Bookshelf",
    "Obsidian", "Crying Obsidian", "Glass", "Tinted Glass", "Glowstone",
    "Netherrack", "Soul Sand", "Soul Soil", "Basalt", "Polished Basalt",
    "Smooth Basalt", "Blackstone", "Polished Blackstone",
    "Polished Blackstone Bricks", "Gilded Blackstone", "Nether Bricks",
    "Red Nether Bricks", "Chiseled Nether Bricks", "Magma Block",
    "Nether Wart Block", "Warped Wart Block", "Shroomlight", "Crimson Nylium",
    "Warped Nylium", "End Stone", "End Stone Bricks", "Purpur Block",
    "Purpur Pillar", "Prismarine", "Prismarine Bricks", "Dark Prismarine",
    "Sea Lantern", "Sponge", "Wet Sponge", "Dried Kelp Block", "TNT",
    "Pumpkin", "Carved Pumpkin", "Jack o'Lantern", "Melon", "Hay Bale",
    "Honey Block", "Honeycomb Block", "Slime Block", "Cactus", "Target Block",
    "Lodestone", "Respawn Anchor", "Crafting Table", "Furnace",
    "Blast Furnace", "Smoker", "Smithing Table", "Fletching Table",
    "Cartography Table", "Loom", "Barrel", "Composter", "Beehive",
    "Bee Nest", "Quartz Block", "Chiseled Quartz Block", "Quartz Bricks",
    "Quartz Pillar", "Smooth Quartz", "Stone Bricks", "Mossy Stone Bricks",
    "Cracked Stone Bricks", "Chiseled Stone Bricks", "Infested Stone",
    "Sculk", "Sculk Catalyst", "Reinforced Deepslate", "Moss Block",
    "Ochre Froglight", "Verdant Froglight", "Pearlescent Froglight",
    "Dripstone Block", "Pointed Dripstone Block", "Suspicious Sand",
    "Suspicious Gravel", "Decorated Pot", "Piston", "Sticky Piston",
    "Observer", "Dispenser", "Dropper", "Hopper", "Redstone Lamp",
    "Note Block", "Jukebox", "Monster Spawner", "Amethyst Cluster",
]

MINECRAFT_DYED_FAMILIES = [
    "Wool", "Concrete", "Concrete Powder", "Terracotta", "Glazed Terracotta",
    "Stained Glass", "Shulker Box", "Candle Block",
]

# Additional solid (full-cube) Minecraft blocks not already covered above:
# deepslate ore variants, deepslate/tuff decorative finishes, copper
# oxidation-stage variants, and mangrove roots.
MISSING_SOLIDS = [
    "Deepslate Coal Ore", "Deepslate Iron Ore", "Deepslate Copper Ore",
    "Deepslate Gold Ore", "Deepslate Redstone Ore", "Deepslate Emerald Ore",
    "Deepslate Lapis Lazuli Ore", "Deepslate Diamond Ore",
    "Chiseled Deepslate", "Cracked Deepslate Bricks",
    "Cracked Deepslate Tiles", "Tuff Bricks", "Polished Tuff",
    "Chiseled Tuff", "Cracked Tuff Bricks", "Waxed Copper Block",
    "Waxed Exposed Copper", "Waxed Weathered Copper",
    "Waxed Oxidized Copper", "Exposed Cut Copper", "Weathered Cut Copper",
    "Oxidized Cut Copper", "Waxed Cut Copper", "Copper Bulb",
    "Exposed Copper Bulb", "Weathered Copper Bulb", "Oxidized Copper Bulb",
    "Copper Grate", "Exposed Copper Grate", "Mangrove Roots",
    "Muddy Mangrove Roots",
]

BUILDING_MATERIALS = [
    "Concrete", "Reinforced Concrete", "Precast Concrete", "Aerated Concrete",
    "Fiber Cement", "Cement Mortar", "Lime Mortar", "Screed", "Grout",
    "Red Brick", "Engineering Brick", "Fire Brick", "Breeze Block",
    "Cinder Block", "Adobe Brick", "Compressed Earth Block", "Rammed Earth",
    "Asphalt", "Tarmac", "Bitumen", "Roofing Felt", "Roof Slate Tile",
    "Clay Roof Tile", "Concrete Roof Tile", "Corrugated Iron",
    "Corrugated Fiberglass", "Structural Steel", "Rebar Steel",
    "Galvanized Steel", "Weathering Steel", "Cast Iron", "Wrought Iron",
    "Aluminium Cladding", "Zinc Cladding", "Copper Cladding",
    "Titanium Cladding", "Plasterboard", "Gypsum Plaster", "Lime Plaster",
    "Stucco", "Venetian Plaster", "Plywood", "OSB Board", "MDF Board",
    "Chipboard", "Hardboard", "Blockboard", "Glulam Timber",
    "Cross-Laminated Timber", "LVL Timber", "Pressure-Treated Lumber",
    "Timber Framing", "Bamboo Composite", "Cork Board", "Linoleum",
    "Vinyl Flooring", "Laminate Flooring", "Parquet", "Epoxy Flooring",
    "Polished Screed", "Terrazzo", "Ceramic Tile", "Porcelain Tile",
    "Quarry Tile", "Mosaic Tile", "Glass Block", "Float Glass",
    "Tempered Glass", "Laminated Glass", "Low-E Glass", "Wired Glass",
    "Frosted Glass", "Acrylic Sheet", "Polycarbonate Sheet", "PVC Pipe",
    "Copper Pipe", "PEX Pipe", "Cast Concrete Paver", "Granite Paver",
    "Sandstone Paver", "Gravel Aggregate", "Crushed Stone", "Ballast",
    "Sharp Sand", "Building Sand", "Silica Sand", "Perlite", "Vermiculite",
    "Mineral Wool", "Glass Wool", "Cellulose Insulation", "Foam Board",
    "Spray Foam", "Straw Bale", "Hempcrete", "Papercrete", "Ferrocement",
    "Gabion Stone", "Riprap", "Geotextile", "Damp-Proof Membrane",
    "Vapor Barrier", "House Wrap", "Green Roof Substrate", "Sod Roof",
]

CRAFTING_MATERIALS = [
    "Stoneware Clay", "Earthenware Clay", "Porcelain Clay", "Polymer Clay",
    "Air-Dry Clay", "Modeling Wax", "Beeswax", "Paraffin Wax", "Soy Wax",
    "Plaster of Paris", "Papier-Mache", "Cardstock", "Corrugated Cardboard",
    "Kraft Paper", "Newsprint", "Vellum", "Parchment", "Tissue Paper",
    "Origami Paper", "Watercolor Paper", "Canvas", "Stretched Canvas",
    "Linen Canvas", "Burlap", "Felt Sheet", "Craft Foam", "EVA Foam",
    "Balsa Wood", "Basswood Sheet", "Popsicle Wood", "Dowel Wood",
    "Wood Veneer", "Leather Hide", "Suede", "Faux Leather", "Cork Sheet",
    "Rubber Sheet", "Silicone Rubber", "Latex Rubber", "Resin Cast",
    "Epoxy Resin", "UV Resin", "Polyester Resin", "Fiberglass Cloth",
    "Carbon Fiber Cloth", "Kevlar Cloth", "Mosaic Glass", "Stained Glass Sheet",
    "Fusing Glass", "Sea Glass", "Mirror Glass", "Acrylic Paint Skin",
    "Oil Paint Impasto", "Encaustic Wax", "Gilding Leaf", "Copper Foil",
    "Aluminum Foil", "Brass Sheet", "Pewter Ingot", "Solder",
    "Jewelry Wire", "Memory Wire", "Chainmail Rings", "Glass Beads",
    "Seed Beads", "Clay Beads", "Wooden Beads", "Embroidery Floss",
    "Yarn Skein", "Roving Wool", "Alpaca Yarn", "Mohair Yarn",
]

ELEMENT_NAMES = [
    "Hydrogen", "Helium", "Lithium", "Beryllium", "Boron", "Carbon",
    "Nitrogen", "Oxygen", "Fluorine", "Neon", "Sodium", "Magnesium",
    "Aluminium", "Silicon", "Phosphorus", "Sulfur", "Chlorine", "Argon",
    "Potassium", "Calcium", "Scandium", "Titanium", "Vanadium", "Chromium",
    "Manganese", "Iron", "Cobalt", "Nickel", "Copper", "Zinc", "Gallium",
    "Germanium", "Arsenic", "Selenium", "Bromine", "Krypton", "Rubidium",
    "Strontium", "Yttrium", "Zirconium", "Niobium", "Molybdenum",
    "Technetium", "Ruthenium", "Rhodium", "Palladium", "Silver", "Cadmium",
    "Indium", "Tin", "Antimony", "Tellurium", "Iodine", "Xenon", "Caesium",
    "Barium", "Lanthanum", "Cerium", "Praseodymium", "Neodymium",
    "Promethium", "Samarium", "Europium", "Gadolinium", "Terbium",
    "Dysprosium", "Holmium", "Erbium", "Thulium", "Ytterbium", "Lutetium",
    "Hafnium", "Tantalum", "Tungsten", "Rhenium", "Osmium", "Iridium",
    "Platinum", "Gold", "Mercury", "Thallium", "Lead", "Bismuth", "Polonium",
    "Astatine", "Radon", "Francium", "Radium", "Actinium", "Thorium",
    "Protactinium", "Uranium", "Neptunium", "Plutonium", "Americium",
    "Curium", "Berkelium", "Californium", "Einsteinium", "Fermium",
    "Mendelevium", "Nobelium", "Lawrencium", "Rutherfordium", "Dubnium",
    "Seaborgium", "Bohrium", "Hassium", "Meitnerium", "Darmstadtium",
    "Roentgenium", "Copernicium", "Nihonium", "Flerovium", "Moscovium",
    "Livermorium", "Tennessine", "Oganesson",
]

ROCKS_AND_GEMS = [
    "Marble", "Carrara Marble", "Nero Marquina Marble", "Travertine",
    "Limestone", "Dolomite", "Chalk", "Slate", "Phyllite", "Schist",
    "Gneiss", "Quartzite", "Soapstone", "Serpentinite", "Rhyolite",
    "Dacite", "Pumice", "Scoria", "Gabbro", "Peridotite", "Kimberlite",
    "Shale", "Mudstone", "Siltstone", "Greywacke", "Conglomerate Rock",
    "Breccia", "Chert", "Jasper", "Agate", "Onyx", "Carnelian",
    "Chalcedony", "Amethyst", "Citrine", "Smoky Quartz", "Rose Quartz",
    "Milky Quartz", "Tiger's Eye", "Opal", "Fire Opal", "Moonstone",
    "Sunstone", "Labradorite", "Amazonite", "Aventurine", "Bloodstone",
    "Malachite", "Azurite", "Lapis Lazuli", "Sodalite", "Turquoise",
    "Chrysocolla", "Rhodochrosite", "Rhodonite", "Garnet", "Almandine",
    "Pyrope", "Spessartine", "Tsavorite", "Peridot", "Topaz",
    "Imperial Topaz", "Aquamarine", "Morganite", "Heliodor", "Emerald",
    "Ruby", "Sapphire", "Padparadscha Sapphire", "Spinel", "Tanzanite",
    "Zircon", "Tourmaline", "Watermelon Tourmaline", "Kunzite", "Iolite",
    "Alexandrite", "Diamond", "Black Diamond", "Pearl", "Black Pearl",
    "Amber", "Jet", "Coral Stone", "Fossiliferous Limestone", "Petrified Wood",
    "Obsidian Snowflake", "Fluorite", "Pyrite", "Galena", "Hematite",
    "Magnetite", "Bauxite", "Cinnabar", "Sphalerite", "Halite", "Gypsum",
    "Selenite", "Alabaster", "Talc", "Mica Schist", "Olivine Basalt",
]

WOOD_SPECIES = [
    "Oak Wood", "White Oak", "Red Oak", "European Beech", "Ash Wood",
    "Maple Wood", "Sugar Maple", "Birch Wood", "Cherry Wood", "Black Cherry",
    "Walnut Wood", "Black Walnut", "Mahogany", "Sapele", "Teak", "Iroko",
    "Ebony", "Rosewood", "Padauk", "Purpleheart", "Zebrano", "Wenge",
    "Bubinga", "Bocote", "Cocobolo", "Lignum Vitae", "Hickory", "Pecan Wood",
    "Elm Wood", "Sycamore Wood", "Poplar Wood", "Aspen Wood", "Alder Wood",
    "Chestnut Wood", "Hornbeam", "Boxwood", "Yew Wood", "Cedar of Lebanon",
    "Western Red Cedar", "Cypress Wood", "Douglas Fir", "Scots Pine",
    "White Pine", "Larch Wood", "Spruce Wood", "Hemlock Wood", "Redwood",
    "Sequoia Wood", "Kauri Wood", "Olive Wood", "Apple Wood", "Pear Wood",
]

METALS_AND_ALLOYS = [
    "Mild Steel", "Carbon Steel", "Tool Steel", "Damascus Steel",
    "Stainless Steel", "Surgical Steel", "Spring Steel", "Crucible Steel",
    "Pig Iron", "Grey Cast Iron", "Ductile Iron", "Meteoric Iron",
    "Electrum", "Sterling Silver", "Rose Gold", "White Gold", "Green Gold",
    "Bronze", "Bell Bronze", "Phosphor Bronze", "Aluminium Bronze",
    "Brass", "Naval Brass", "Cartridge Brass", "Nickel Silver", "Cupronickel",
    "Monel", "Inconel", "Hastelloy", "Invar", "Nitinol", "Duralumin",
    "Magnesium Alloy", "Zamak", "Pewter", "Britannia Metal", "Solder Alloy",
    "Amalgam", "Ferrochrome", "Galinstan",
]

FABRICS = [
    "Cotton Cloth", "Denim", "Canvas Duck", "Twill", "Corduroy", "Flannel",
    "Muslin", "Calico", "Chambray", "Poplin Fabric", "Seersucker", "Terrycloth",
    "Linen Cloth", "Ramie Cloth", "Hemp Cloth", "Jute Cloth", "Silk",
    "Dupioni Silk", "Charmeuse", "Chiffon", "Organza", "Taffeta", "Velvet",
    "Velour", "Brocade", "Damask Fabric", "Jacquard", "Tweed", "Herringbone Wool",
    "Merino Wool", "Cashmere", "Angora", "Felted Wool", "Fleece", "Polyester Cloth",
    "Nylon Ripstop", "Spandex", "Neoprene Fabric", "Gore-Tex", "Cordura",
]

PLASTICS = [
    "ABS Plastic", "PLA Plastic", "PETG Plastic", "Nylon Polymer",
    "Polypropylene", "Polyethylene HDPE", "Polyethylene LDPE", "PVC Rigid",
    "PVC Flexible", "Polystyrene", "Expanded Polystyrene", "Polycarbonate",
    "Acrylic PMMA", "PTFE Teflon", "POM Acetal", "PEEK Polymer",
    "Polyurethane Foam", "TPU Flexible", "Bakelite", "Melamine Resin",
    "Epoxy Solid", "Vinyl Ester", "Silicone Solid", "Bioplastic PHA",
    "Cellulose Acetate", "Casein Plastic", "Ebonite", "Celluloid",
    "Acetal Copolymer", "Ultem PEI",
]

HISTORICAL_MATERIALS = [
    "Wattle and Daub", "Cob", "Thatch", "Sod Block", "Peat Block",
    "Timber Cruck", "Ship-Lap Boards", "Roman Concrete", "Opus Reticulatum",
    "Terracotta Army Clay", "Fired Adobe", "Mudbrick", "Snow Brick (Igloo)",
    "Whale Bone Frame", "Hide Covering", "Birch Bark Sheeting", "Bamboo Pole",
    "Rattan Weave", "Palm Frond Thatch", "Coral Block (Masonry)",
    "Shell Lime Plaster", "Tabby Concrete", "Flint Knapped Facing",
    "Dry Stone", "Turf Wall", "Log Cabin Round", "Half-Timber Infill",
    "Stone Slab Megalith", "Stacked Slate", "Oyster Shell Aggregate",
]

STONE_FINISHES = ["Honed", "Flamed", "Bush-Hammered", "Sandblasted", "Tumbled"]
FINISH_STONES = [
    "Granite", "Marble", "Limestone", "Travertine", "Basalt", "Slate",
    "Sandstone", "Quartzite", "Gneiss", "Bluestone", "Porphyry", "Dolerite",
]


def _hash01(text: str, salt: str = "") -> float:
    digest = hashlib.sha256((salt + text).encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") / 0xFFFFFFFF


def _derive_color(name: str, category: str) -> str:
    """Deterministic, name-stable pleasant color."""
    hue = _hash01(name, "hue")
    sat = 0.25 + 0.45 * _hash01(name, "sat")
    lit = 0.35 + 0.35 * _hash01(name, "lit")
    if category == "Element":
        sat *= 0.6  # elements skew metallic / muted
        lit = 0.4 + 0.3 * _hash01(name, "lit")
    r, g, b = colorsys.hls_to_rgb(hue, lit, sat)
    return "#%02x%02x%02x" % (int(r * 255), int(g * 255), int(b * 255))


def _mix(hex_color: str, factor: float) -> str:
    """Lighten (>0) or darken (<0) a hex color."""
    r = int(hex_color[1:3], 16)
    g = int(hex_color[3:5], 16)
    b = int(hex_color[5:7], 16)
    if factor >= 0:
        r = int(r + (255 - r) * factor)
        g = int(g + (255 - g) * factor)
        b = int(b + (255 - b) * factor)
    else:
        r = int(r * (1 + factor))
        g = int(g * (1 + factor))
        b = int(b * (1 + factor))
    return "#%02x%02x%02x" % (r, g, b)


# Interactive materials, appended after the catalog is padded so the ids of
# all other materials stay stable. "action" marks materials that generate
# events the backend can respond to; "screen" marks display surfaces.
INTERACTIVE_MATERIALS = [
    ("Screen", "#0d1016", "screen"),
    ("Touch Sensor", "#d9484c", "touch"),
    ("Light Sensor", "#ffd94a", "light"),
    ("Pressure Plate", "#3fbf9f", "pressure"),
    ("Lamp", "#fff1cf", "lamp"),
    ("Sand Faucet", "#c8b984", "faucet"),
    ("Water Faucet", "#4a7bd9", "faucet"),
    ("Lava Faucet", "#e2661e", "faucet"),
]

# Wood-family names that burn in lava / float in water
_FLAMMABLE_HINTS = ("Planks", "Log", " Wood", "Bookshelf", "Hay Bale",
                    "Timber", "Plywood", "Lumber")

# Light-emitting materials: {name: light level 1..15}. The client's voxel
# lighting engine floods block-light from these.
EMISSIVE_LEVELS = {
    "Lamp": 15,
    "Glowstone": 15,
    "Sea Lantern": 15,
    "Lava": 15,
    "Ochre Froglight": 15,
    "Verdant Froglight": 15,
    "Pearlescent Froglight": 15,
    "Shroomlight": 12,
    "Jack o'Lantern": 12,
    "Redstone Lamp": 12,
    "Lava Faucet": 10,
    "Magma Block": 8,
    "Crying Obsidian": 7,
    "Amethyst Cluster": 5,
}

# Materials light passes through (they don't block sky- or block-light).
_TRANSLUCENT_HINTS = ("Glass",)
_TRANSLUCENT_EXACT = {"Water", "Ice", "Packed Ice", "Blue Ice"}

# ---------------------------------------------------------------------------
# Composite "object" materials: fixed voxel shapes (stairs, fences, panes,
# poles, ...) built from many small sub-voxels rather than a single solid
# color. Each is defined in objects/{slug}.txt: lines of
# "X Y Z RRGGBB[AA]" (comments '#', blank lines skipped; X/Y/Z are integers
# in OBJECT_UNIT_MM units; alpha 00 means the cell is skipped/not placed).
# If a listed object's file is missing, it still gets a catalog entry
# (marked objectMissing) so the gap is visible/actionable rather than the
# material silently not existing; a startup warning is printed too.
# ---------------------------------------------------------------------------
OBJECT_MATERIAL_NAMES = [
    "Oak Stairs", "Stone Slab", "Oak Fence", "Iron Bars", "Glass Pane",
    "Oak Door", "Iron Trapdoor", "Stone Pressure Plate", "Stone Button",
    "Torch", "Lantern", "Chain", "Ladder", "Pole",
]

# Object-name hints propagated onto an object's resolved swatch materials
# (regular per-material hint matching doesn't apply to swatches, since
# their names are just "Object Swatch #rrggbb").
OBJECT_EMISSIVE_HINTS = {"Torch": 12, "Lantern": 14}
OBJECT_TRANSLUCENT_HINTS = ("Glass", "Pane")
OBJECT_WOOD_PREFIXES = ("Oak", "Spruce", "Birch", "Jungle", "Acacia",
                        "Dark Oak", "Mangrove", "Cherry", "Bamboo",
                        "Crimson", "Warped")


def _object_slug(name):
    return re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")


def _parse_object_file(path):
    cells = []
    for lineno, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 4:
            print(f"warning: {path.name}:{lineno}: expected "
                  f"'X Y Z RRGGBB[AA]', got {raw!r}")
            continue
        try:
            x, y, z = int(parts[0]), int(parts[1]), int(parts[2])
            hexcolor = parts[3]
            if len(hexcolor) == 6:
                r, g, b, a = (int(hexcolor[0:2], 16), int(hexcolor[2:4], 16),
                             int(hexcolor[4:6], 16), 255)
            elif len(hexcolor) == 8:
                r, g, b, a = (int(hexcolor[0:2], 16), int(hexcolor[2:4], 16),
                             int(hexcolor[4:6], 16), int(hexcolor[6:8], 16))
            else:
                raise ValueError("color must be 6 or 8 hex chars")
        except ValueError as err:
            print(f"warning: {path.name}:{lineno}: {err} ({raw!r})")
            continue
        if a == 0:
            continue  # fully transparent: not placed
        cells.append((x, y, z, r, g, b))
    return cells


def load_objects():
    """Load objects/*.txt shape definitions for OBJECT_MATERIAL_NAMES.
    Returns {name: {"cells": [(x,y,z,r,g,b), ...], "found": bool}}."""
    objects = {}
    for name in OBJECT_MATERIAL_NAMES:
        path = OBJECTS_DIR / f"{_object_slug(name)}.txt"
        if path.is_file():
            objects[name] = {"cells": _parse_object_file(path), "found": True}
        else:
            print(f"warning: missing object definition for {name!r} "
                  f"(expected {path})")
            objects[name] = {"cells": [], "found": False}
    return objects


def build_materials():
    materials = []
    seen = set()

    def add(name, category, color=None, action=None):
        if name in seen:
            return None
        seen.add(name)
        if color is None:
            color = KNOWN_COLORS.get(name) or _derive_color(name, category)
        entry = {
            "id": len(materials) + 1,  # 0 is air
            "name": name,
            "category": category,
            "color": color,
        }
        if action:
            entry["action"] = action
        materials.append(entry)
        return entry

    for name in MINECRAFT_BASE:
        add(name, "Minecraft")
    for family in MINECRAFT_DYED_FAMILIES:
        for dye, color in DYE_COLORS.items():
            add(f"{dye} {family}", "Minecraft", color)
    for name in MISSING_SOLIDS:
        add(name, "Minecraft")
    for name in BUILDING_MATERIALS:
        add(name, "Building")
    for name in CRAFTING_MATERIALS:
        add(name, "Crafting")
    for name in ELEMENT_NAMES:
        add(f"Element: {name}", "Element")
    for name in ROCKS_AND_GEMS:
        add(name, "Rocks & Gems")
    for name in WOOD_SPECIES:
        add(name, "Wood")
    for name in METALS_AND_ALLOYS:
        add(name, "Metal & Alloy")
    for name in FABRICS:
        add(name, "Textile")
    for name in PLASTICS:
        add(name, "Plastic & Polymer")
    for name in HISTORICAL_MATERIALS:
        add(name, "Historical")

    for finish in STONE_FINISHES:
        for stone in FINISH_STONES:
            base = KNOWN_COLORS.get(stone) or _derive_color(stone, "Rocks & Gems")
            shade = (_hash01(finish + stone) - 0.5) * 0.3
            add(f"{finish} {stone}", "Stone Finish", _mix(base, shade))

    # Pad with a generated paint swatch series until we pass the minimum.
    swatch = 0
    while len(materials) < MINIMUM_MATERIALS:
        hue = (swatch * 137.508) % 360  # golden-angle spread
        tone = swatch % 3
        sat = (0.85, 0.55, 0.3)[tone]
        lit = (0.5, 0.65, 0.4)[tone]
        r, g, b = colorsys.hls_to_rgb(hue / 360.0, lit, sat)
        color = "#%02x%02x%02x" % (int(r * 255), int(g * 255), int(b * 255))
        add(f"Paint Swatch {swatch + 1:03d} (H{int(hue):03d})", "Paint", color)
        swatch += 1

    for name, color, action in INTERACTIVE_MATERIALS:
        add(name, "Interactive", color, action)

    # Composite objects: mint/reuse a swatch material per distinct cell
    # color, then one outward-facing catalog entry per object shape.
    color_to_id = {}
    for m in materials:
        color_to_id.setdefault(m["color"], m["id"])

    object_defs = load_objects()
    for name in OBJECT_MATERIAL_NAMES:
        info = object_defs[name]
        resolved_cells = []
        for x, y, z, r, g, b in info["cells"]:
            hexcolor = "#%02x%02x%02x" % (r, g, b)
            mat_id = color_to_id.get(hexcolor)
            if mat_id is None:
                swatch = add(f"Object Swatch {hexcolor}", "Object Swatch",
                             hexcolor)
                mat_id = swatch["id"]
                color_to_id[hexcolor] = mat_id
            resolved_cells.append([x, y, z, mat_id])

        rep_color = ("#%02x%02x%02x" % info["cells"][0][3:6]
                     if info["cells"] else "#9a9a9a")
        entry = add(name, "Object", rep_color)
        entry["object"] = True
        entry["cells"] = resolved_cells
        if not info["found"]:
            entry["objectMissing"] = True

        emissive_level = next(
            (lvl for hint, lvl in OBJECT_EMISSIVE_HINTS.items()
             if hint in name), None)
        is_translucent = any(h in name for h in OBJECT_TRANSLUCENT_HINTS)
        is_wood = name.startswith(OBJECT_WOOD_PREFIXES)
        if emissive_level or is_translucent or is_wood:
            swatch_ids = {c[3] for c in resolved_cells}
            for m in materials:
                if m["id"] in swatch_ids:
                    if emissive_level:
                        m["emissive"] = max(m.get("emissive", 0),
                                            emissive_level)
                    if is_translucent:
                        m["translucent"] = True
                    if is_wood:
                        m["flammable"] = True

    for m in materials:
        if m["category"] == "Wood" or \
                any(h in m["name"] for h in _FLAMMABLE_HINTS):
            m["flammable"] = True
        level = EMISSIVE_LEVELS.get(m["name"])
        if level:
            m["emissive"] = level
        if m["name"] in _TRANSLUCENT_EXACT or \
                any(h in m["name"] for h in _TRANSLUCENT_HINTS):
            m["translucent"] = True

    assert len(materials) >= MINIMUM_MATERIALS, len(materials)
    return materials


MATERIALS = build_materials()
NAME_TO_ID = {m["name"]: m["id"] for m in MATERIALS}
GRANITE_ID = NAME_TO_ID["Granite"]


if __name__ == "__main__":
    from collections import Counter
    print(f"total materials: {len(MATERIALS)}")
    print(Counter(m["category"] for m in MATERIALS))
    print("granite id:", GRANITE_ID)
