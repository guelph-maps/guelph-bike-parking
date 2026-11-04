// Bicycle parking types (OSM `bicycle_parking=*`), with a colour and a
// 24×24 line glyph drawn in white on the marker.
window.BIKE_PARKING_TYPES = (function () {
  var P = 'M8.5 20V4h4.5a4.25 4.25 0 0 1 0 8.5H8.5'; // the letter "P"

  var types = [
    {
      key: 'stands', label: 'Bike stands', hint: 'Inverted-U or post stands — lock frame and wheel',
      color: '#1d4ed8', glyph: 'M3 20.5h18M7 20.5V10a5 5 0 0 1 10 0v10.5'
    },
    {
      key: 'wave', label: 'Wave rack', hint: 'One wavy tube for several bikes — lock frame and wheel',
      color: '#047857', glyph: 'M3 20.5h18M4 20.5V8.5a2.67 2.67 0 0 1 5.33 0v6a2.67 2.67 0 0 0 5.33 0v-6a2.67 2.67 0 0 1 5.33 0v12'
    },
    {
      key: 'rack', label: 'Rack', hint: 'Multi-bike rack, e.g. a hoop with rings along the top',
      color: '#7c3aed', glyph: 'M3 20.5h18M4 9h16M6 9v11.5M10 9v11.5M14 9v11.5M18 9v11.5'
    },
    {
      key: 'bollard', label: 'Post & ring', hint: 'Single post or bollard with a ring',
      color: '#0e7490', glyph: 'M12 3v18M8 21h8M12 6.5a4 4 0 1 0 0 8a4 4 0 1 0 0-8'
    },
    {
      key: 'wall_loops', label: 'Wheel bender', hint: 'Front-wheel loops — wheel only, less secure',
      color: '#be185d', glyph: 'M4 3v18M4 7h8a2.5 2.5 0 0 1 0 5H4M4 14h8a2.5 2.5 0 0 1 0 5H4'
    },
    {
      key: 'ground_slots', label: 'Ground slots', hint: 'Slots in the ground for a wheel',
      color: '#4d7c0f', glyph: 'M3 20h5v-3h8v3h5M12 6a5 5 0 1 0 0 10a5 5 0 1 0 0-10'
    },
    {
      key: 'shed', label: 'Shelter / shed', hint: 'Covered shelter or bike shed',
      color: '#c2410c', glyph: 'M3 11l9-7 9 7M5.5 9.5V20h13V9.5M9.5 20v-5h5v5'
    },
    {
      key: 'lockers', label: 'Bike lockers', hint: 'Enclosed lockers, usually rented',
      color: '#a16207', glyph: 'M3.5 4.5h7.5v15H3.5zM13 4.5h7.5v15H13zM8.5 11v2M15.5 11v2'
    },
    {
      key: 'building', label: 'Bike room', hint: 'Indoor bike room or parking garage',
      color: '#334155', glyph: 'M3 20.5V9l9-5 9 5v11.5M7 20.5v-8h10v8M7 16.5h10'
    },
    {
      key: 'two-tier', label: 'Two-tier rack', hint: 'Stacked rack with an upper level',
      color: '#4338ca', glyph: 'M4 8h16M4 16h16M6 4v16.5M18 4v16.5'
    },
    {
      key: 'other', label: 'Other', hint: 'Saddle holders, informal spots and other types',
      color: '#64748b', glyph: P
    },
    {
      key: 'unknown', label: 'Type not recorded', hint: 'Rack type not yet mapped in OpenStreetMap',
      color: '#94a3b8', glyph: P
    }
  ];

  var byKey = {};
  types.forEach(function (t) { byKey[t.key] = t; });

  return {
    list: types,
    // Maps any raw OSM value to one of the keys above.
    resolve: function (raw) {
      if (!raw || raw === 'unknown') return byKey.unknown;
      if (raw === 'anchors' || raw === 'safe_loops' || raw === 'wide_stands') return byKey.stands;
      if (raw === 'handlebar_holder' || raw === 'crossbar') return byKey.rack;
      return byKey[raw] || byKey.other;
    },
    svg: function (type, size) {
      return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true">' +
        '<path d="' + type.glyph + '" fill="none" stroke="currentColor" stroke-width="2.2" ' +
        'stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
  };
})();
