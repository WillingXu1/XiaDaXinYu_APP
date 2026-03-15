import React, { useState, useEffect } from 'react';
import { X, Camera, Star, Tag, Upload } from 'lucide-react';

const DiaryModal = ({ entry, onSave, onClose }) => {
  const [formData, setFormData] = useState({
    mood: '',
    rating: 3,
    content: '',
    tags: [],
    image: ''
  });

  const moods = ['开心', '平静', '一般', '焦虑', '低落'];
  const availableTags = ['学业', '人际', '未来', '身体', '自然', '美食', '友谊', '压力', '放松'];

  useEffect(() => {
    if (entry) {
      setFormData(entry);
    }
  }, [entry]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!formData.mood || !formData.content.trim()) {
      alert('请填写心情和内容');
      return;
    }
    onSave(formData);
  };

  const handleTagToggle = (tag) => {
    setFormData(prev => ({
      ...prev,
      tags: prev.tags.includes(tag)
        ? prev.tags.filter(t => t !== tag)
        : [...prev.tags, tag]
    }));
  };

  // 分析情绪并生成对应图片
  const generateMoodImage = () => {
    // 根据心情和评分确定情绪倾向
    const isPositive = (formData.mood === '开心' || formData.mood === '平静') && formData.rating >= 3;
    const isNegative = (formData.mood === '焦虑' || formData.mood === '低落') || formData.rating <= 2;
    
    let keywords = [];
    
    if (isPositive) {
      // 积极情绪 - 明亮、温暖的图片
      keywords = ['sunset', 'flowers', 'butterfly', 'rainbow', 'lake', 'mountain', 'cherry,blossom', 'sunny,garden', 'happy,cartoon'];
    } else if (isNegative) {
      // 消极情绪 - 柔和、平静的图片
      keywords = ['rain', 'clouds', 'misty', 'forest', 'ocean', 'twilight', 'gentle,stream', 'peaceful,landscape', 'calm,cartoon'];
    } else {
      // 中性情绪 - 平衡的图片
      keywords = ['nature', 'study', 'food', 'friends', 'campus', 'relax', 'peaceful,garden', 'neutral,landscape', 'balanced,cartoon'];
    }
    
    const randomKeyword = keywords[Math.floor(Math.random() * keywords.length)];
    const imageUrl = `https://nocode.meituan.com/photo/search?keyword=${randomKeyword}&width=400&height=300`;
    setFormData(prev => ({ ...prev, image: imageUrl }));
  };

  // 用户上传图片
  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setFormData(prev => ({ ...prev, image: e.target.result }));
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-gray-800">
            {entry ? '编辑日记' : '写新日记'}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <X className="w-6 h-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* 心情选择 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              今天的心情
            </label>
            <div className="grid grid-cols-5 gap-2">
              {moods.map((mood) => (
                <button
                  key={mood}
                  type="button"
                  onClick={() => setFormData(prev => ({ ...prev, mood }))}
                  className={`p-3 rounded-lg border-2 text-sm font-medium transition-all duration-200 ${
                    formData.mood === mood
                      ? 'border-purple-500 bg-purple-50 text-purple-700'
                      : 'border-gray-200 hover:border-purple-300'
                  }`}
                >
                  {mood}
                </button>
              ))}
            </div>
          </div>

          {/* 心情评分 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              心情评分
            </label>
            <div className="flex items-center gap-2">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  onClick={() => setFormData(prev => ({ ...prev, rating: star }))}
                  className="transition-colors duration-200"
                >
                  <Star
                    className={`w-6 h-6 ${
                      star <= formData.rating
                        ? 'text-yellow-400 fill-current'
                        : 'text-gray-300'
                    }`}
                  />
                </button>
              ))}
              <span className="text-sm text-gray-600 ml-2">
                {formData.rating}/5
              </span>
            </div>
          </div>

          {/* 内容输入 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              今天发生了什么
            </label>
            <textarea
              value={formData.content}
              onChange={(e) => setFormData(prev => ({ ...prev, content: e.target.value }))}
              placeholder="记录今天的心情和发生的事情..."
              className="w-full p-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent resize-none"
              rows="4"
            />
          </div>

          {/* 标签选择 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              添加标签
            </label>
            <div className="flex flex-wrap gap-2">
              {availableTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => handleTagToggle(tag)}
                  className={`px-3 py-1 rounded-full text-sm transition-all duration-200 ${
                    formData.tags.includes(tag)
                      ? 'bg-purple-500 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-purple-100'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          {/* 图片上传 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              添加图片
            </label>
            {formData.image ? (
              <div className="relative">
                <img
                  src={formData.image}
                  alt="日记配图"
                  className="w-full h-48 mx-auto object-cover rounded-lg"
                />
                <button
                  type="button"
                  onClick={() => setFormData(prev => ({ ...prev, image: '' }))}
                  className="absolute top-2 right-2 w-8 h-8 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600 transition-colors duration-200"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={generateMoodImage}
                  className="w-full h-32 border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center text-gray-500 hover:border-purple-300 hover:text-purple-600 transition-all duration-200"
                >
                  <div className="text-center">
                    <Camera className="w-8 h-8 mx-auto mb-2" />
                    <p className="text-sm">根据情绪生成图片</p>
                  </div>
                </button>
                <div className="relative">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <button
                    type="button"
                    className="w-full h-32 border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center text-gray-500 hover:border-purple-300 hover:text-purple-600 transition-all duration-200"
                  >
                    <div className="text-center">
                      <Upload className="w-8 h-8 mx-auto mb-2" />
                      <p className="text-sm">上传本地图片</p>
                    </div>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 提交按钮 */}
          <button
            type="submit"
            className="w-full bg-gradient-to-r from-blue-500 to-purple-500 text-white py-3 rounded-lg font-medium hover:shadow-lg transition-all duration-200"
          >
            {entry ? '保存修改' : '保存日记'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default DiaryModal;
