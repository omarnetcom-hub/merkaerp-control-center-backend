function requireRole(role) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const roles = user.roles || [];
    const isAdmin = user.is_admin || user.role === 'admin';
    if (isAdmin || roles.includes(role)) return next();
    return res.status(403).json({ error: 'Forbidden: insufficient role' });
  };
}

module.exports = { requireRole };
