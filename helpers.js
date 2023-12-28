function backfill(obj, template) {

  let modified = false;

  for (const prop in template) {
    if (!obj.hasOwnProperty(prop)) {
      obj[prop] = template[prop];
      modified = true;
    }

    if (isObject(template[prop])) {
      modified = backfill(obj[prop], template[prop]) || modified;
    }
  }

  return modified ? obj : false;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function isObject(x) {
  return !Array.isArray(x) && typeof x == 'object';
}

module.exports = {
  backfill,
  clone,
};
